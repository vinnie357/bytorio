import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { serve } from "../../tools/serve.mjs";
import { run, nativePlayer } from "../../tools/toolchain.mjs";
import * as input from "../../runtime/odin/web/constants.js";

const root = resolve("build/compact-3d/riverside");
const HIGH_DISPLAY_BUTTON = 16;
const geometry = JSON.parse(await readFile(resolve(root, "geometry.json")));
const report = { status: "running", cases: [] };
const server = serve(".", 0);
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PLAYER_BROWSER_CHANNEL || "chrome" });
try {
  for (const language of ["odin", "luau"]) {
    const base = `/build/compact-3d/riverside/${language}/build/web`;
    const page = await browser.newPage({ viewport: { width: 1920, height: 1400 } });
    await page.goto(`${origin}${base}/debug.html?renderer=gpu&surface-samples&smooth-pan`);
    await page.waitForFunction(() => window.playerStatus?.ready || window.playerStatus?.error);
    assert.equal(await page.evaluate(() => window.playerStatus.error), "");
    assert(await page.locator("#graphics-surface").isChecked());
    assert(await page.locator("#graphics-resident").isChecked());
    assert(await page.locator("#graphics-snap").isChecked());

    // Exercise the actual settings controls and preserve the ordinary CPU path.
    await page.locator("#graphics-backend").selectOption("cpu");
    assert(await page.locator("#graphics-surface").isDisabled());
    assert.equal(await page.locator("#graphics-surface").isChecked(), false);
    await page.locator("#graphics-backend").selectOption("gpu");
    await page.locator("#graphics-surface").check();

    const fixture = await page.evaluate(async (base) => {
      const { createGpu } = await import(base + "/gpu.js");
      const gpu = await createGpu({ ssaa: "off", surfaceSamples: true });
      try {
        const memory = { buffer: new ArrayBuffer(16384) };
        const data = new DataView(memory.buffer);
        const corners = [
          [-1, -1, 0.25],
          [1, -1, 0.25],
          [1, 1, 0.25],
          [-1, 1, 0.25],
        ];
        corners.forEach((p, i) => {
          p.forEach((v, axis) => data.setFloat32(i * 16 + axis * 4, v, true));
          data.setUint32(i * 16 + 12, 0xff0000ff, true);
        });
        [0, 2, 1, 0, 3, 2].forEach((v, i) => data.setUint32(64 + i * 4, v, true));
        new Float32Array(memory.buffer, 128, 16).set([
          1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
        ]);
        const render = (version, z) => {
          new Uint8Array(memory.buffer, 512, 32 * 32 * 4).fill(0);
          for (let i = 0; i < 32 * 32; i++) {
            data.setFloat32(4608 + i * 4, z, true);
          }
          gpu.queueMesh(memory, version, 0, 0, 4, 6, 0, 128, 128, 256, 1);
          if (!gpu.raster(memory, 0, 0, 512, 4608, 32, 32, 0, 0, 32, 32, 0, 1, 2)) {
            throw new Error("Sample fixture raster failed");
          }
          return [
            data.getUint32(512 + (16 * 32 + 16) * 4, true),
            data.getFloat32(4608 + (16 * 32 + 16) * 4, true),
          ];
        };
        const visible = render(1, 1);
        render(1, 1);
        const reuse = { ...gpu.metrics };
        const occluded = render(1, 0.125);
        [0, 1, 2, 0, 2, 3].forEach((v, i) => data.setUint32(64 + i * 4, v, true));
        const culled = render(2, 1);
        return { visible, occluded, culled, reuse };
      } finally {
        gpu.close();
      }
    }, base);
    assert.deepEqual(fixture.visible, [0xff0000ff, 0.25]);
    assert.deepEqual(fixture.occluded, [0, 0.125]);
    assert.deepEqual(fixture.culled, [0, 1]);
    assert.equal(fixture.reuse.meshUploads, 1);
    assert.equal(fixture.reuse.cacheHits, 1);
    assert.equal(fixture.reuse.cacheBytes, 192);

    for (const ssaa of ["off", "2x", "1080p"]) {
      for (const width of [320, 640]) {
        const high = width === 640 ? HIGH_DISPLAY_BUTTON : 0;
        const masks = [
          ...Array(geometry.loadingUpdates + 2).fill(high),
          ...Array(5).fill(high | input.BUTTON_MOVE_RIGHT),
          ...Array(5).fill(high | input.BUTTON_ROTATE_LEFT),
          ...Array(5).fill(high | input.BUTTON_PAN_RIGHT),
        ];
        const replay = resolve(root, `${language}-surface-${ssaa}-${width}.inputs`);
        const capture = resolve(root, `${language}-surface-${ssaa}-${width}.rgba`);
        await writeFile(replay, masks.join("\n") + "\n");
        const native = run(
          resolve(root, `${language}/build/native/${nativePlayer}`),
          [
            "--replay",
            replay,
            "--renderer",
            "gpu",
            "--surface-samples",
            "--ssaa",
            ssaa,
            "--smooth-pan",
            "--capture-rgba",
            capture,
          ],
          { timeout: 120000 },
        )
          .trim()
          .split(/\r?\n/)
          .map(JSON.parse);
        assert.equal(native.length, masks.length);
        const web = await page.evaluate(
          async ({ base, masks, ssaa, width }) => {
            const worker = new Worker(base + "/worker.js", { type: "module" });
            const request = (message, type) =>
              new Promise((resolve, reject) => {
                const timer = setTimeout(
                  () => reject(new Error("Surface verification deadline")),
                  120000,
                );
                worker.onerror = (event) => {
                  clearTimeout(timer);
                  reject(new Error(event.message));
                };
                worker.onmessage = async ({ data }) => {
                  if (data.type === "executor") {
                    const bytes = await (await fetch(base + "/luau-executor.wasm")).arrayBuffer();
                    worker.postMessage({ type: "executor", executor: { bytes } }, [bytes]);
                  } else if (data.type === "error") {
                    clearTimeout(timer);
                    reject(new Error(data.error));
                  } else if (data.type === type) {
                    clearTimeout(timer);
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
                  graphics: { backend: "gpu", surfaceSamples: true, smoothPan: true, ssaa },
                  presentationSize: [1920, 1080],
                },
                "ready",
              );
              let frame;
              const hashes = [];
              for (const buttons of masks) {
                frame = await request(
                  { type: "step", steps: 1, input: { buttons, pointer: false, x: 0, y: 0 } },
                  "frame",
                );
                frame.bitmap?.close();
                hashes.push(frame.hash);
              }
              const uploads = frame.metrics.meshUploads;
              const cacheBytes = frame.metrics.gpuCacheBytes;
              const redraw = await request({ type: "step", steps: 0, render: true }, "frame");
              redraw.bitmap?.close();
              if (
                redraw.hash !== frame.hash ||
                redraw.metrics.meshUploads !== uploads ||
                redraw.metrics.gpuCacheBytes !== cacheBytes
              ) {
                throw new Error("Unchanged surface draws rebuilt geometry or changed the output");
              }
              const snapshot = await request({ type: "capture" }, "capture");
              const pixels = new Uint8Array(snapshot.pixels);
              let binary = "";
              for (let i = 0; i < pixels.length; i += 8192) {
                binary += String.fromCharCode(...pixels.subarray(i, i + 8192));
              }
              if (
                frame.width !== width ||
                !frame.smoothPresentation ||
                frame.presentationWidth !== 1920
              ) {
                throw new Error("Surface resolution or smooth presentation is inactive");
              }
              return { hashes, uploads, cacheBytes, rgba: btoa(binary), hash: frame.hash };
            } finally {
              worker.terminate();
            }
          },
          { base, masks, ssaa, width },
        );
        assert.equal(web.uploads, Math.ceil(geometry.worldQuads / geometry.facesPerUpload) + 1);
        assert(
          new Set(web.hashes.slice(-15)).size > 5,
          "walking, orbit and pan update the sampled image",
        );
        // Independent expected surface area: four samples per original unit face,
        // represented by one 48-byte patch rather than four 36-byte point records.
        assert.equal(web.cacheBytes, ((1023096 + 8052) / 6) * 48);
        const expected = await readFile(capture);
        const actual = Buffer.from(web.rgba, "base64");
        assert.equal(actual.length, width * ((width * 9) / 16) * 4);
        assert.equal(expected.length, actual.length);
        let changed = 0,
          squared = 0;
        const colors = new Set();
        for (let i = 0; i < actual.length; i += 4) {
          colors.add(actual.readUInt32LE(i));
          if (!actual.subarray(i, i + 4).equals(expected.subarray(i, i + 4))) {
            changed++;
          }
          for (let c = 0; c < 3; c++) {
            squared += (actual[i + c] - expected[i + c]) ** 2;
          }
        }
        assert(colors.size > 30, "whole scene contains visible colored surfaces");
        const png = await page.evaluate(
          ({ rgba, width }) => {
            const bytes = Uint8Array.from(atob(rgba), (v) => v.charCodeAt(0));
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = (width * 9) / 16;
            canvas
              .getContext("2d")
              .putImageData(
                new ImageData(new Uint8ClampedArray(bytes.buffer), canvas.width, canvas.height),
                0,
                0,
              );
            return canvas.toDataURL("image/png").split(",")[1];
          },
          { rgba: web.rgba, width },
        );
        await writeFile(
          resolve(root, `${language}-surface-${ssaa}-${width}.png`),
          Buffer.from(png, "base64"),
        );
        const changedFraction = changed / (actual.length / 4);
        const rms = Math.sqrt(squared / ((actual.length / 4) * 3));
        assert(
          changedFraction <= 0.02 && rms <= 3,
          `native/browser surface coverage: ${changedFraction}, RMS ${rms}`,
        );
        report.cases.push({
          language,
          width,
          ssaa,
          hash: web.hash,
          nativeHash: native.at(-1).hash,
          meshUploads: web.uploads,
          cacheBytes: web.cacheBytes,
          changedFraction,
          rms,
        });
        console.log(`${language}/${width}/${ssaa}: surface samples passed`);
      }
    }
    await page.close();
  }
  for (const item of report.cases.filter((row) => row.language === "odin")) {
    const other = report.cases.find(
      (row) => row.language === "luau" && row.width === item.width && row.ssaa === item.ssaa,
    );
    assert.equal(item.hash, other.hash, "both SDKs produce identical surface images");
    assert.equal(item.nativeHash, other.nativeHash, "native SDK surface parity");
  }
  report.status = "passed";
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
  await writeFile(resolve(root, "surface-report.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(
  "Whole-scene surface samples passed: both SDKs, native/browser, both resolutions, SSAA, controls and resident reuse.",
);
