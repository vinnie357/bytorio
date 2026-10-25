import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "./browser-timing.mjs";
import { serve } from "./serve.mjs";
import { tool, run, copySdlLibrary, nativeLinkerFlags, nativePlayer } from "./toolchain.mjs";
import { odinUnitTests } from "./odin-unit-tests.mjs";

const root = resolve("build/gpu-validation");
await mkdir(root, { recursive: true });
odinUnitTests("tests/3d", resolve(root, "resources.exe"));
run(tool("odin"), [
  "build",
  "tests/gpu/native",
  "-o:none",
  `-out:${root}/device.exe`,
  ...nativeLinkerFlags({ harness: true }),
]);
await copySdlLibrary(root);
const report = {
  status: "running",
  nativeFixture: JSON.parse(run(resolve(root, "device.exe"), [])),
  cases: [],
};
assert.equal(report.nativeFixture.pixel, 0xff0000ff);
assert.equal(report.nativeFixture.depth, 0.25);
const server = serve(".", 0);
await once(server, "listening");
const browser = await chromium.launch({ channel: process.env.PLAYER_BROWSER_CHANNEL || "chrome" });
try {
  for (const language of ["odin", "luau"]) {
    for (const residentMeshes of [false, true]) {
      for (const ssaa of ["off", "2x", "1080p"]) {
        const page = await browser.newPage();
        const base = `/build/compact-3d/${language}/build/web`;
        await page.goto(
          `http://127.0.0.1:${server.address().port}${base}/player.html?renderer=gpu&ssaa=${ssaa}&pixel-snap&smoke${residentMeshes ? "&gpu-meshes" : ""}`,
        );
        await page.waitForFunction(() => window.playerStatus?.ready || window.playerStatus?.error);
        await page.locator("#start").click();
        await page.waitForFunction(
          () => window.playerStatus.ticks >= 120 || window.playerStatus.error,
        );
        const status = await page.evaluate(() => window.playerStatus);
        assert.equal(status.error, "");
        assert.equal(status.graphics.effective, "gpu");
        const native = JSON.parse(
          run(resolve(`build/compact-3d/${language}/build/native/${nativePlayer}`), [
            "--check",
            "--renderer",
            "gpu",
            "--ssaa",
            ssaa,
            "--pixel-snap",
            ...(residentMeshes ? ["--gpu-meshes"] : []),
          ]),
        );
        assert.equal(status.hash, native.hash, `${language}/${ssaa}: native/browser GPU parity`);
        report.cases.push({
          language,
          ssaa,
          residentMeshes,
          hash: status.hash,
          width: status.width,
          height: status.height,
        });
        await page.close();
      }
    }
    const page = await browser.newPage({ viewport: { width: 1920, height: 1400 } });
    const base = `/build/compact-3d/${language}/build/web`;
    await page.goto(
      `http://127.0.0.1:${server.address().port}${base}/player.html?renderer=gpu&ssaa=1080p&smooth-pan`,
    );
    await page.waitForFunction(() => window.playerStatus?.ready || window.playerStatus?.error);
    assert.equal(await page.evaluate(() => window.playerStatus.error), "");
    assert(await page.evaluate(() => window.playerStatus.smoothPresentation));
    assert(
      await page.evaluate(
        () => document.querySelector("#canvas").width > window.playerStatus.width,
      ),
    );
    const frames = await page.evaluate(
      async ({ base, language }) => {
        const worker = new Worker(base + "/worker.js", { type: "module" });
        const request = (message, type) =>
          new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("GPU worker timeout")), 10000);
            worker.onerror = (event) => {
              clearTimeout(timeout);
              reject(new Error(event.message));
            };
            worker.onmessage = ({ data }) => {
              if (data.type === "error") {
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
              gameUrl: location.origin + base + (language === "odin" ? "/game.wasm" : "/game.luau"),
              graphics: { backend: "gpu", ssaa: "1080p", smoothPan: true },
              presentationSize: [1920, 1080],
            },
            "ready",
          );
          const high = await request(
            { type: "step", steps: 1, input: { buttons: 16, pointer: false, x: 0, y: 0 } },
            "frame",
          );
          const drawOnly = await request({ type: "step", steps: 0, render: true }, "frame");
          const perspective = await request(
            { type: "step", steps: 1, input: { buttons: 2, pointer: false, x: 0, y: 0 } },
            "frame",
          );
          const single = await request(
            { type: "step", steps: 1, input: { buttons: 0, pointer: false, x: 0, y: 0 } },
            "frame",
          );
          const catchup = await request(
            { type: "step", steps: 5, input: { buttons: 0, pointer: false, x: 0, y: 0 } },
            "frame",
          );
          for (const frame of [high, drawOnly, perspective, single, catchup]) {
            frame.bitmap?.close();
          }
          return {
            drawOnlyStable:
              drawOnly.hash === high.hash &&
              drawOnly.ticks === high.ticks &&
              drawOnly.sounds === high.sounds,
            catchup: {
              ticks: catchup.ticks - single.ticks,
              uploadRatio: catchup.metrics.gpuUploadBytes / single.metrics.gpuUploadBytes,
            },
            high: {
              hash: high.hash,
              width: high.width,
              presentationWidth: high.presentationWidth,
              smooth: high.smoothPresentation,
            },
            perspective: {
              smooth: perspective.smoothPresentation,
              width: perspective.width,
              presentationWidth: perspective.presentationWidth,
            },
          };
        } finally {
          worker.terminate();
        }
      },
      { base, language },
    );
    assert.equal(frames.high.width, 640);
    assert(frames.drawOnlyStable, "GPU draw-only frames preserve image, ticks and sound events");
    assert.equal(frames.high.presentationWidth, 1920);
    assert(frames.high.smooth);
    assert.equal(frames.perspective.smooth, false);
    assert.equal(frames.perspective.presentationWidth, 320);
    assert.equal(frames.catchup.ticks, 5, "catch-up preserves every fixed simulation tick");
    assert(frames.catchup.uploadRatio < 1.2, "five catch-up updates render the scene once");
    const inputs = resolve(root, "action.inputs");
    await writeFile(inputs, "16\n");
    const nativeHigh = JSON.parse(
      run(resolve(`build/compact-3d/${language}/build/native/${nativePlayer}`), [
        "--replay",
        inputs,
        "--renderer",
        "gpu",
        "--ssaa",
        "1080p",
        "--smooth-pan",
      ]),
    );
    assert.equal(nativeHigh.hash, frames.high.hash);
    report.cases.push({ language, smooth: frames });
    await page.locator("#graphics-backend").selectOption("cpu");
    await page.locator("#graphics-apply").click();
    await page.waitForFunction(
      () =>
        (window.playerStatus.ready && window.playerStatus.graphics?.effective === "cpu") ||
        window.playerStatus.error,
    );
    assert.equal(await page.evaluate(() => window.playerStatus.error), "");
    assert.equal(await page.evaluate(() => window.playerStatus.graphics.requested.ssaa), "1080p");
    await page.close();
    // CPU quality must work without creating a WebGL execution device.
    for (const ssaa of ["off", "2x", "1080p"]) {
      const cpuPage = await browser.newPage();
      await cpuPage.goto(
        `http://127.0.0.1:${server.address().port}/experiments/voxel-resolution/benchmark-host.html`,
      );
      const traces = await cpuPage.evaluate(
        async ({ base, ssaa }) => {
          const worker = new Worker(base + "/worker.js", { type: "module" });
          const request = (message, type) =>
            new Promise((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error("CPU quality deadline")), 30000);
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
            const ready = await request(
              {
                type: "load",
                gameUrl: location.origin + base + "/game.png",
                graphics: { backend: "cpu", ssaa, smoothPan: true },
                presentationSize: [1920, 1080],
              },
              "ready",
            );
            if (ready.graphics.effective !== "cpu") {
              throw new Error("CPU quality unexpectedly selected GPU");
            }
            const rows = [];
            for (const buttons of [0, 16]) {
              const frame = await request(
                { type: "step", steps: 1, input: { buttons, pointer: false, x: 0, y: 0 } },
                "frame",
              );
              if (
                !frame.smoothPresentation ||
                frame.presentationWidth !== 1920 ||
                !frame.metrics.cpuQualityBytes ||
                frame.bitmap
              ) {
                throw new Error("CPU quality presentation inactive");
              }
              rows.push({ hash: frame.hash, sounds: frame.sounds });
            }
            return rows;
          } finally {
            worker.terminate();
          }
        },
        { base, ssaa },
      );
      const inputs = resolve(root, "cpu-quality.inputs");
      await writeFile(inputs, "0\n16\n");
      const native = run(
        resolve(`build/compact-3d/${language}/build/native/${nativePlayer}`),
        ["--replay", inputs, "--renderer", "cpu", "--ssaa", ssaa, "--smooth-pan"],
        { env: { ...process.env, SDL_VIDEODRIVER: "dummy" } },
      )
        .trim()
        .split(/\r?\n/)
        .map(JSON.parse);
      assert.deepEqual(traces, native, `${language}/${ssaa}: exact CPU quality host parity`);
      report.cases.push({ language, cpuQuality: ssaa, traces });
      await cpuPage.close();
    }
  }
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/build/odin-player/web/player.html`);
  await page.waitForFunction(() => window.playerStatus?.ready);
  report.browserFixtures = await page.evaluate(async () => {
    const { createGpu, normalizeGraphics } = await import("./gpu.js");
    const rows = [];
    for (const ssaa of ["off", "2x", "1080p"]) {
      const device = await createGpu(normalizeGraphics({ backend: "gpu", ssaa }));
      const memory = new WebAssembly.Memory({ initial: 1 });
      const vertices = new Float32Array(memory.buffer, 0, 21);
      vertices.set([
        -0.8, -0.8, 0.25, 1, 255, 0, 0, 0, 0.8, 0.25, 1, 255, 0, 0, 0.8, -0.8, 0.25, 1, 255, 0, 0,
      ]);
      const color = 256,
        depth = color + 32 * 32 * 4;
      new Float32Array(memory.buffer, depth, 32 * 32).fill(1);
      const result = device.raster(
        memory,
        0,
        3,
        color,
        depth,
        32,
        32,
        0,
        0,
        32,
        32,
        0xff000000,
        1,
        2,
      );
      const center = (16 * 32 + 16) * 4;
      const rgba = Array.from(new Uint8Array(memory.buffer, color + center, 4));
      const z = new Float32Array(memory.buffer, depth + center, 1)[0];
      const colors = new Uint8Array(memory.buffer, color, 32 * 32 * 4);
      const coverage = colors.filter((v, i) => i % 4 === 3 && v > 0 && v < 255).length;
      rows.push({ ssaa, result, rgba, z, coverage });
      // Original positions and indices are immutable across cached draws.
      const packed = new DataView(memory.buffer);
      const meshOffset = 16384,
        matrixOffset = 16512,
        lightOffset = 16576;
      for (let i = 0; i < 3; i++) {
        for (let axis = 0; axis < 3; axis++) {
          packed.setFloat32(meshOffset + i * 16 + axis * 4, vertices[i * 7 + axis], true);
        }
        packed.setUint32(meshOffset + i * 16 + 12, 0xff0000ff, true);
        packed.setUint32(meshOffset + 48 + i * 4, i, true);
      }
      const identity = new Float32Array(memory.buffer, matrixOffset, 16);
      identity.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      for (let i = 0; i < 2; i++) {
        new Uint8Array(memory.buffer, color, 32 * 32 * 4).fill(0);
        new Float32Array(memory.buffer, depth, 32 * 32).fill(1);
        device.queueMesh(
          memory,
          1,
          0,
          meshOffset,
          3,
          3,
          0,
          matrixOffset,
          matrixOffset,
          lightOffset,
          1,
        );
        if (
          device.raster(memory, 0, 0, color, depth, 32, 32, 0, 0, 32, 32, 0xff000000, 1, 2) !== 1 ||
          packed.getUint32(color + center, true) !== 0xff0000ff ||
          packed.getFloat32(depth + center, true) !== 0.25
        ) {
          throw new Error("Resident triangle fixture failed");
        }
      }
      if (
        device.metrics.meshUploads !== 1 ||
        device.metrics.cacheHits !== 1 ||
        device.metrics.cacheBytes !== 144
      ) {
        throw new Error("Resident upload lifecycle failed");
      }
      rows[rows.length - 1].resident = { ...device.metrics };
      // Deferred batches keep both attachments private, including depth at
      // sample resolution. CPU memory changes only at the explicit barrier.
      new Uint8Array(memory.buffer, color, 32 * 32 * 4).fill(0);
      new Float32Array(memory.buffer, depth, 32 * 32).fill(1);
      const before = { ...device.metrics };
      const draw = (count, continuation, deferReadback, w = 32) =>
        device.raster(
          memory,
          0,
          count,
          color,
          depth,
          w,
          32,
          0,
          0,
          w,
          32,
          0xff000000,
          1,
          2,
          0,
          continuation,
          deferReadback,
        );
      if (draw(3, 0, 1) !== 1 || packed.getUint32(color + center, true) !== 0) {
        throw new Error("Deferred attachment leaked into CPU storage");
      }
      for (let i = 0; i < 3; i++) {
        vertices[i * 7 + 2] = 0.75;
        vertices[i * 7 + 4] = 0;
        vertices[i * 7 + 6] = 255;
      }
      if (
        draw(3, 1, 1) !== 1 ||
        draw(0, 1, 0) !== 1 ||
        packed.getUint32(color + center, true) !== 0xff0000ff ||
        packed.getFloat32(depth + center, true) !== 0.25 ||
        device.metrics.attachmentUploadBytes - before.attachmentUploadBytes !== 8192 ||
        device.metrics.attachmentReadbackBytes - before.attachmentReadbackBytes !== 8192 ||
        device.metrics.attachmentBatches - before.attachmentBatches !== 2 ||
        device.metrics.attachmentSequences - before.attachmentSequences !== 1
      ) {
        throw new Error("Resident attachment color/depth or transfer count failed");
      }
      if (
        draw(0, 1, 0) !== 0 ||
        draw(0, 0, 1) !== 1 ||
        draw(0, 1, 0, 16) !== 0 ||
        draw(0, 1, 0) !== 0 ||
        draw(0, 0, 0) !== 1 ||
        !device.metrics.attachmentBytes
      ) {
        throw new Error("Attachment continuation failure/recovery failed");
      }
      rows[rows.length - 1].attachments = { ...device.metrics };
      // The committed GPU image is independent of CPU output and later private
      // rendering. The HUD mask is deliberately a color-independent assertion.
      new Uint8Array(memory.buffer, color, 32 * 32 * 4).fill(0);
      new Float32Array(memory.buffer, depth, 32 * 32).fill(1);
      for (let i = 0; i < 3; i++) {
        vertices[i * 7 + 2] = 0.25;
        vertices[i * 7 + 4] = 255;
        vertices[i * 7 + 6] = 0;
      }
      const mask = 24576;
      new Uint8Array(memory.buffer, mask, 32 * 32).fill(0);
      const beforeFrame = { ...device.metrics };
      if (draw(3, 0, 1) !== 1) {
        throw new Error("Private frame raster failed");
      }
      new Uint8Array(memory.buffer)[mask + center / 4] = 1;
      packed.setUint32(color + center, 0xff00ff00, true);
      if (
        device.stageFrame(memory, color, depth, 0, mask, 32, 32, 101, 0) !== 1 ||
        device.publishFrame(101, 0) !== 1
      ) {
        throw new Error("GPU frame publication failed");
      }
      const present = () => {
        const frame = device.present(memory, color, 0, 0, 32, 32, 32, 32, 0, 0, 0xff000000, 101, 0);
        const context = new OffscreenCanvas(32, 32).getContext("2d");
        context.drawImage(frame.bitmap, 0, 0);
        frame.bitmap.close();
        if (
          String(context.getImageData(16, 16, 1, 1).data) !== "0,255,0,255" ||
          String(context.getImageData(16, 18, 1, 1).data) !== "255,0,0,255"
        ) {
          throw new Error("Direct GPU world/HUD presentation failed");
        }
      };
      present();
      present();
      if (
        device.metrics.attachmentReadbackBytes !== beforeFrame.attachmentReadbackBytes ||
        device.metrics.presentationUploadBytes - beforeFrame.presentationUploadBytes !==
          32 * 32 * 5 ||
        device.metrics.directPresents - beforeFrame.directPresents !== 2
      ) {
        throw new Error("Direct frame unexpectedly transferred CPU snapshots");
      }
      for (let i = 0; i < 3; i++) {
        vertices[i * 7 + 4] = 0;
        vertices[i * 7 + 6] = 255;
      }
      if (
        draw(3, 0, 1) !== 1 ||
        device.stageFrame(memory, color, depth, 0, mask, 32, 32, 102, 0) !== 1
      ) {
        throw new Error("Candidate frame failed");
      }
      present();
      if (
        device.readFrame(memory, color, depth, 0, mask, 32, 32, 101, 0) !== 1 ||
        packed.getUint32(color + center, true) !== 0xff00ff00 ||
        packed.getUint32(color + (18 * 32 + 16) * 4, true) !== 0xff0000ff ||
        packed.getFloat32(depth + center, true) !== 0.25 ||
        device.publishFrame(102, 0) !== 1 ||
        device.readFrame(memory, color, depth, 0, mask, 32, 32, 101, 0) !== 0
      ) {
        throw new Error("Committed frame isolation/readback failed");
      }
      const lose = device.gl.getExtension("WEBGL_lose_context");
      if (lose) {
        await new Promise((resolve) => {
          device.gl.canvas.addEventListener(
            "webglcontextlost",
            (event) => {
              event.preventDefault();
              resolve();
            },
            { once: true },
          );
          lose.loseContext();
        });
        if (device.readFrame(memory, color, depth, 0, mask, 32, 32, 102, 0) !== 0) {
          throw new Error("Lost device accepted a committed snapshot read");
        }
        let failed = false;
        try {
          device.present(memory, color, 0, 0, 32, 32, 32, 32, 0, 0, 0xff000000, 102, 0);
        } catch {
          failed = true;
        }
        if (!failed) {
          throw new Error("Lost device accepted direct presentation");
        }
      }
      device.invalidateFrames();
      if (device.publishFrame(102, 0) !== 0) {
        throw new Error("Stale frame survived invalidation");
      }
      rows[rows.length - 1].committed = { ...device.metrics };
      device.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    const device = await createGpu(normalizeGraphics({ backend: "gpu" }));
    const memory = new WebAssembly.Memory({ initial: 16 });
    const output = 0,
      preview = 320 * 180 * 4,
      mask = preview + 322 * 182 * 4;
    const pixels = new Uint32Array(memory.buffer, preview, 322 * 182);
    for (let y = 0; y < 182; y++) {
      for (let x = 0; x < 322; x++) {
        pixels[y * 322 + x] = (0xff000000 | (x % 256) | ((y % 256) << 8)) >>> 0;
      }
    }
    new Uint8Array(memory.buffer)[mask + 90 * 320 + 160] = 1;
    new Uint32Array(memory.buffer)[90 * 320 + 160] = 0xffff00ff;
    const displayed = device.present(
      memory,
      output,
      preview,
      mask,
      320,
      180,
      1920,
      1080,
      1 / 6,
      0,
      0xff000000,
    );
    device.finish();
    const context = new OffscreenCanvas(1920, 1080).getContext("2d");
    context.drawImage(displayed.bitmap, 0, 0);
    displayed.bitmap.close();
    if (
      String(context.getImageData(101, 100, 1, 1).data) !== "18,17,0,255" ||
      String(context.getImageData(960, 540, 1, 1).data) !== "255,0,255,255"
    ) {
      throw new Error("GPU presentation orientation/residual/HUD fixture failed");
    }
    device.close();
    return rows;
  });
  for (const row of report.browserFixtures) {
    assert.equal(row.result, 1);
    assert.deepEqual(row.rgba, [255, 0, 0, 255]);
    assert.equal(row.z, 0.25);
    assert.equal(row.coverage > 0, row.ssaa !== "off");
  }
  await page.close();
  const unavailable = await chromium.launch({
    channel: process.env.PLAYER_BROWSER_CHANNEL || "chrome",
  });
  try {
    const fallbackPage = await unavailable.newPage();
    // Inject device unavailability in the Worker; browser launch switches do
    // not consistently disable OffscreenCanvas WebGL on installed browsers.
    await fallbackPage.route("**/worker.js", async (route) => {
      const response = await route.fetch();
      const body =
        `const originalContext=OffscreenCanvas.prototype.getContext;
OffscreenCanvas.prototype.getContext=function(kind,...args){return kind==="webgl2"?null:originalContext.call(this,kind,...args);};\n` +
        (await response.text());
      await route.fulfill({ response, body });
    });
    const base = `http://127.0.0.1:${server.address().port}/build/odin-player/web/player.html`;
    await fallbackPage.goto(base + "?renderer=auto");
    await fallbackPage.waitForFunction(
      () => window.playerStatus?.ready || window.playerStatus?.error,
    );
    assert.equal(await fallbackPage.evaluate(() => window.playerStatus.graphics?.effective), "cpu");
    await fallbackPage.goto(base + "?renderer=gpu");
    await fallbackPage.waitForFunction(() => window.playerStatus?.error);
    assert.match(await fallbackPage.evaluate(() => window.playerStatus.error), /WebGL 2/);
    await fallbackPage.goto(base + "?renderer=invalid");
    await fallbackPage.waitForFunction(() => window.playerStatus?.error);
    assert.match(await fallbackPage.evaluate(() => window.playerStatus.error), /Invalid graphics/);
  } finally {
    await unavailable.close();
  }
  const player = resolve("build/odin-player/native", nativePlayer);
  const automatic = JSON.parse(
    run(player, ["--check", "--renderer", "auto"], {
      env: { ...process.env, SDL_VIDEODRIVER: "dummy" },
    }),
  );
  const reference = JSON.parse(run(player, ["--check", "--renderer", "cpu"]));
  assert.equal(automatic.hash, reference.hash);
  report.fallbacks = {
    browser: "injected unavailable WebGL2 context",
    native: "SDL dummy video driver",
  };
  report.status = "passed";
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
  await writeFile(resolve(root, "report.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
