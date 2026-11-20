import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { serve } from "../../tools/serve.mjs";
import { run, nativePlayer } from "../../tools/toolchain.mjs";
import * as input from "../../runtime/odin/web/constants.js";

const root = resolve("build/compact-3d/riverside");
const geometry = JSON.parse(await readFile(resolve(root, "geometry.json")));
const report = { status: "running", cases: [] };
const server = serve(".", 0);
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PLAYER_BROWSER_CHANNEL || "chrome" });
try {
  for (const language of ["odin", "luau"]) {
    const base = `/build/compact-3d/riverside/${language}/build/web`;
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.goto(`${origin}${base}/debug.html?renderer=gpu&gpu-meshes&ssaa=1080p&smooth-pan`);
    const ready = async () => {
      await page.waitForFunction(() => window.playerStatus?.ready || window.playerStatus?.error);
      assert.equal(await page.evaluate(() => window.playerStatus.error), "");
    };
    await ready();
    await page.locator("#start").click();
    await page.waitForFunction(
      (tick) => window.playerStatus.ticks >= tick || window.playerStatus.error,
      geometry.loadingUpdates + 4,
    );
    const status = () =>
      page.evaluate(() => {
        // Normal resident GPU frames intentionally omit logical readback hashes.
        // Inspect the presented canvas here, without changing player diagnostics.
        const canvas = document.getElementById("canvas");
        const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        const hashOffsetBasis = 2166136261;
        const hashPrime = 16777619;
        let presentedHash = hashOffsetBasis;
        for (const value of pixels) {
          presentedHash = Math.imul(presentedHash ^ value, hashPrime) >>> 0;
        }
        return { ...window.playerStatus, presentedHash };
      });
    const key = async (name, frames = 8) => {
      await page.keyboard.down(name);
      const pressed = await page.evaluate(() => window.playerStatus.ticks);
      await page.waitForFunction(
        (tick) => window.playerStatus.ticks >= tick || window.playerStatus.error,
        pressed + frames,
      );
      await page.keyboard.up(name);
      const released = await page.evaluate(() => window.playerStatus.ticks);
      await page.waitForFunction(
        (tick) => window.playerStatus.ticks >= tick || window.playerStatus.error,
        released + 2,
      );
      await ready();
      return status();
    };
    const initial = await status();
    const moved = await key("d", 12);
    assert(moved.x > initial.x + 1, `${language}: D walks the rabbit`);
    const panned = await key("ArrowRight");
    assert.equal(panned.x, moved.x);
    assert.equal(panned.y, moved.y);
    assert.notEqual(
      panned.presentedHash,
      moved.presentedHash,
      `${language}: arrow pans without moving rabbit`,
    );
    const rotated = await key("q");
    assert.equal(rotated.x, moved.x);
    assert.notEqual(rotated.presentedHash, panned.presentedHash, `${language}: Q rotates camera`);
    const reset = await key("r", 2);
    assert.equal(reset.x, -4);
    assert.equal(reset.y, 19);
    for (const name of ["a", "w", "s"]) {
      const position = await key(name);
      assert(
        Math.abs(position.x + 4) + Math.abs(position.y - 19) > 0.5,
        `${language}: ${name} moves`,
      );
      await key("r", 2);
    }
    const metrics = (await status()).metrics;
    assert(Number.isFinite(metrics.gpuUploadBytes));
    assert(metrics.memory.runtimeLinear > 0 && metrics.gpuCacheBytes > 0);
    assert.match(await page.locator("#performance").textContent(), /FPS delivered/);
    await page.close();

    const masks = [
      ...Array(geometry.loadingUpdates + 1).fill(0),
      ...Array(8).fill(input.BUTTON_MOVE_RIGHT),
      ...Array(8).fill(input.BUTTON_PAN_RIGHT),
      ...Array(8).fill(input.BUTTON_ROTATE_LEFT),
      input.BUTTON_RESET,
    ];
    const replay = resolve(root, `${language}-controls.inputs`);
    await writeFile(replay, masks.join("\n") + "\n");
    const native = run(
      resolve(root, `${language}/build/native/${nativePlayer}`),
      ["--replay", replay, "--renderer", "cpu"],
      { timeout: 120000 },
    )
      .trim()
      .split(/\r?\n/)
      .map(JSON.parse);
    const host = await browser.newPage();
    await host.goto(`${origin}/experiments/voxel-resolution/benchmark-host.html`);
    const qualityMasks = [...Array(geometry.loadingUpdates + 1).fill(0), 16];
    const web = await host.evaluate(
      async ({ base, masks, qualityMasks }) => {
        const worker = new Worker(base + "/worker.js", { type: "module" });
        const request = (message, type) =>
          new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Control replay deadline")), 120000);
            worker.onerror = (event) => {
              clearTimeout(timeout);
              reject(new Error(event.message));
            };
            worker.onmessage = async ({ data }) => {
              if (data.type === "executor") {
                const bytes = await (await fetch(base + "/luau-executor.wasm")).arrayBuffer();
                worker.postMessage({ type: "executor", executor: { bytes } }, [bytes]);
              } else if (data.type === "error") {
                clearTimeout(timeout);
                reject(new Error(data.error));
              } else if (data.type === type) {
                clearTimeout(timeout);
                resolve(data);
              }
            };
            worker.postMessage(message);
          });
        try {
          await request(
            {
              type: "load",
              gameUrl: location.origin + base + "/game.png",
              graphics: { backend: "cpu" },
            },
            "ready",
          );
          const traces = [];
          for (const buttons of masks) {
            const frame = await request(
              { type: "step", steps: 1, input: { buttons, pointer: false, x: 0, y: 0 } },
              "frame",
            );
            traces.push({ hash: frame.hash, sounds: frame.sounds });
          }
          await request(
            {
              type: "load",
              gameUrl: location.origin + base + "/game.png",
              graphics: { backend: "cpu", ssaa: "1080p", smoothPan: true },
              presentationSize: [1920, 1080],
            },
            "ready",
          );
          const quality = [];
          for (let i = 0; i < qualityMasks.length; i++) {
            const frame = await request(
              {
                type: "step",
                steps: 1,
                input: { buttons: qualityMasks[i], pointer: false, x: 0, y: 0 },
              },
              "frame",
            );
            quality.push({ hash: frame.hash, sounds: frame.sounds });
            if (
              i >= qualityMasks.length - 2 &&
              (!frame.smoothPresentation ||
                frame.presentationWidth !== 1920 ||
                !frame.metrics.cpuQualityBytes ||
                frame.bitmap)
            ) {
              throw new Error("Full riverside CPU quality inactive");
            }
          }
          return { traces, quality };
        } finally {
          worker.terminate();
        }
      },
      { base, masks, qualityMasks },
    );
    await host.close();
    assert.deepEqual(web.traces, native, `${language}: exact CPU control replay across hosts`);
    await writeFile(replay, qualityMasks.join("\n") + "\n");
    const nativeQuality = run(
      resolve(root, `${language}/build/native/${nativePlayer}`),
      ["--replay", replay, "--renderer", "cpu", "--ssaa", "1080p", "--smooth-pan"],
      { timeout: 120000, env: { ...process.env, SDL_VIDEODRIVER: "dummy" } },
    )
      .trim()
      .split(/\r?\n/)
      .map(JSON.parse);
    assert.deepEqual(
      web.quality,
      nativeQuality,
      `${language}: exact full-scene CPU quality native/browser replay`,
    );
    report.cases.push({
      language,
      ui: "WASD/QE/arrows/reset and live counters",
      frames: masks.length,
      replay: "exact CPU native/browser hashes",
      cpuQuality:
        "1080p supersampling, snapped camera and smooth presentation at both logical sizes",
    });
  }
  report.status = "passed";
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
  await writeFile(resolve(root, "controls-report.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify(report));
