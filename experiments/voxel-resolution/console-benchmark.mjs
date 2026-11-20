import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { serve } from "../../tools/serve.mjs";
import { run, nativePlayer } from "../../tools/toolchain.mjs";

const root = resolve("build/compact-3d/riverside");
const measuredFrames = 30;
const geometry = JSON.parse(await readFile(resolve(root, "geometry.json")));
const loadingFrames = geometry.loadingUpdates + 7;
const replayFrames = measuredFrames + loadingFrames;
const deadlineMs = 240000;
const budgetMs = 1000 / 60;
const channel = process.env.PLAYER_BROWSER_CHANNEL || "chrome";
const imageBound = {
  maxChangedPixelFraction: 0.001,
  maxRms8BitChannelDelta: 0.5,
  linearRoundingMargin: 2 / 255,
};
const sourceFiles = [
  "console-game.odin",
  "console-game.luau",
  "console-decode.luau",
  "console-mesh.mjs",
  "console-build.mjs",
  "console-benchmark.mjs",
];
const report = {
  status: "running",
  recordedAt: new Date().toISOString(),
  revision: run("git", ["rev-parse", "HEAD"]).trim(),
  cpu: cpus()[0].model,
  geometry,
  sources: Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(new URL(name, import.meta.url)))
          .digest("hex"),
      ]),
    ),
  ),
  method: {
    warmupPasses: 2,
    measuredPasses: 5,
    measuredFramesPerPass: measuredFrames,
    excludedLoadingFramesPerPass: loadingFrames,
    presentation: [1920, 1080],
    budgetMs,
    residentImageBound: {
      ...imageBound,
      maxLinearDelta: "one supersample (1/factor²) plus linearRoundingMargin",
      sameHostSdkParity: "exact logical hashes",
    },
    scope:
      "Actual cartridge update, resource transport/validation, resident mesh draw, GPU synchronization/readbacks, logical CPU composition and GPU smooth presentation. GPU completion is synchronized. Excludes window/compositor/scanout, audio and Worker postMessage delivery; not pure GPU timings or physical 60 Hz proof.",
  },
  binaries: {},
  cases: [],
};
const server = serve(".", 0);
await once(server, "listening");
const browser = await chromium.launch({ channel });
const origin = `http://127.0.0.1:${server.address().port}`;
const quantile = (values, fraction) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.floor(values.length * fraction))
  ];
function summarize(record, host) {
  assert.equal(record.timings.length, replayFrames * 5);
  const rows = record.timings.filter((_, i) => i % replayFrames >= loadingFrames);
  const totals = rows.map((row) => row.reduce((a, b) => a + b, 0));
  return {
    samples: totals.length,
    p50Ms: quantile(totals, 0.5),
    p95Ms: quantile(totals, 0.95),
    maxMs: Math.max(...totals),
    overBudget: totals.filter((value) => value > budgetMs).length,
    stagesP95Ms: Object.fromEntries(
      (host === "browser"
        ? ["update", "drawSubmit", "rasterAndPresent", "pixelCopy"]
        : ["update", "drawSubmit", "rasterAndPresent"]
      ).map((name, index) => [
        name,
        quantile(
          rows.map((row) => row[index]),
          0.95,
        ),
      ]),
    ),
    startup: record.startup,
    memory: record.memory,
    resourceStats: record.resourceStats,
    gpuStats: record.gpuStats,
  };
}
try {
  report.browser = browser.version();
  const cdp = await browser.newBrowserCDPSession();
  const info = await cdp.send("SystemInfo.getInfo");
  report.devices = info.gpu.devices;
  report.features = info.gpu.featureStatus;
  for (const language of ["odin", "luau"]) {
    const base = `/build/compact-3d/riverside/${language}/build/web`;
    const executable = resolve(root, `${language}/build/native/${nativePlayer}`);
    report.binaries[language] = Object.fromEntries(
      await Promise.all(
        [
          ["player", executable],
          ["cartridge", resolve(root, `${language}/build/game.png`)],
          ["browserRuntime", resolve(root, `${language}/build/web/runtime-gpu.wasm`)],
          ["browserGpu", resolve(root, `${language}/build/web/gpu.js`)],
          ["browserWorker", resolve(root, `${language}/build/web/worker.js`)],
          ["residentShader", resolve(root, `${language}/build/web/gpu-shaders/resident.vert`)],
          ["presentationShader", resolve(root, `${language}/build/web/gpu-shaders/present.frag`)],
        ].map(async ([name, path]) => [
          name,
          createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
        ]),
      ),
    );
    const page = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
    await page.goto(`${origin}${base}/player.html`);
    // Discard the player's idle Worker before creating the measured Worker.
    await page.goto(`${origin}/experiments/voxel-resolution/benchmark-host.html`);
    for (const width of [320, 640]) {
      for (const motion of ["pan", "orbit"]) {
        const mask = (motion === "pan" ? 1 : 2) | (width === 640 ? 16 : 0) | 4;
        const masks = Array(replayFrames).fill(mask);
        const replayPath = resolve(root, `${language}-${motion}-${width}.inputs`);
        await writeFile(replayPath, masks.join("\n") + "\n");
        const native = JSON.parse(
          run(
            executable,
            [
              "--benchmark",
              replayPath,
              "--renderer",
              "gpu",
              "--gpu-meshes",
              "--ssaa",
              "1080p",
              "--smooth-pan",
            ],
            { timeout: deadlineMs },
          ),
        );
        const web = await page.evaluate(
          async ({ base, masks, deadlineMs, nativeTraces }) => {
            const worker = new Worker(base + "/worker.js", { type: "module" });
            const request = (message, type) =>
              new Promise((resolve, reject) => {
                const timeout = setTimeout(
                  () => reject(new Error("Riverside Worker deadline")),
                  deadlineMs,
                );
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
                  graphics: {
                    backend: "gpu",
                    ssaa: "1080p",
                    smoothPan: true,
                    residentMeshes: true,
                  },
                  presentationSize: [1920, 1080],
                },
                "ready",
              );
              if (ready.graphics.effective !== "gpu") {
                throw new Error("GPU was not selected");
              }
              ready.bitmap?.close();
              const record = await request({ type: "benchmark", masks }, "benchmark");
              const diagnostics = [];
              for (let frame = 0; frame < record.traces.length; frame++) {
                if (record.traces[frame].hash === nativeTraces[frame].hash) {
                  continue;
                }
                await request(
                  { type: "benchmark", masks: masks.slice(0, frame + 1), diagnostic: true },
                  "benchmark",
                );
                const capture = await request({ type: "capture" }, "capture");
                const bytes = new Uint8Array(capture.pixels);
                let binary = "";
                for (let offset = 0; offset < bytes.length; offset += 8192) {
                  binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
                }
                diagnostics.push({ frame, rgba: btoa(binary) });
              }
              if (diagnostics.length) {
                await request({ type: "benchmark", masks, diagnostic: true }, "benchmark");
              }
              const frame = await request(
                {
                  type: "step",
                  steps: 1,
                  input: { buttons: masks[0], pointer: false, x: 0, y: 0 },
                },
                "frame",
              );
              if (!frame.smoothPresentation || frame.presentationWidth !== 1920) {
                throw new Error("Smooth 1080p presentation inactive");
              }
              document.body.innerHTML = '<canvas id="capture" width="1920" height="1080"></canvas>';
              const context = document.querySelector("canvas").getContext("2d");
              if (!frame.bitmap) {
                throw new Error("GPU bitmap presentation inactive");
              }
              context.drawImage(frame.bitmap, 0, 0);
              frame.bitmap.close();
              const pixels = context.getImageData(0, 0, 1920, 1080).data;
              const colors = new Set();
              for (let i = 0; i < pixels.length; i += 4) {
                colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
              }
              if (colors.size < 50) {
                throw new Error("Riverside frame is unexpectedly empty");
              }
              return {
                ...record,
                diagnostics,
                visibleColors: colors.size,
                smooth: frame.smoothPresentation,
                width: frame.width,
              };
            } finally {
              worker.terminate();
            }
          },
          { base, masks, deadlineMs, nativeTraces: native.traces },
        );
        assert.equal(web.width, width);
        assert.equal(native.gpuStats.gpuPresentation, true);
        assert.equal(web.gpuStats.gpuPresentation, true);
        assert(native.gpuStats.cacheHits > 0);
        assert(web.gpuStats.cacheHits > 0);
        const expectedUploads = (Math.ceil(report.geometry.worldQuads / 512) + 1) * 7;
        assert.equal(
          native.gpuStats.meshUploads,
          expectedUploads,
          "Native geometry uploads only during loading",
        );
        assert.equal(
          web.gpuStats.meshUploads,
          expectedUploads,
          "Browser geometry uploads only during loading",
        );
        const pixelChecks = [];
        for (const diagnostic of web.diagnostics) {
          const path = resolve(root, `${language}-${motion}-${width}-frame-${diagnostic.frame}`);
          await writeFile(path + ".inputs", masks.slice(0, diagnostic.frame + 1).join("\n") + "\n");
          const replay = run(
            executable,
            [
              "--replay",
              path + ".inputs",
              "--renderer",
              "gpu",
              "--gpu-meshes",
              "--ssaa",
              "1080p",
              "--smooth-pan",
              "--capture-rgba",
              path + ".native.rgba",
            ],
            { timeout: deadlineMs },
          );
          assert.equal(
            JSON.parse(replay.trim().split(/\r?\n/).at(-1)).hash,
            native.traces[diagnostic.frame].hash,
          );
          const expected = await readFile(path + ".native.rgba");
          const actual = Buffer.from(diagnostic.rgba, "base64");
          await writeFile(path + ".browser.rgba", actual);
          assert.equal(actual.length, expected.length);
          let changedPixels = 0,
            maxChannelDelta = 0,
            maxLinearDelta = 0,
            squaredError = 0;
          const linear = (byte) => {
            const value = byte / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          };
          for (let i = 0; i < expected.length; i += 4) {
            let changed = false;
            for (let channel = 0; channel < 4; channel++) {
              const delta = Math.abs(expected[i + channel] - actual[i + channel]);
              maxChannelDelta = Math.max(maxChannelDelta, delta);
              squaredError += delta * delta;
              const componentDelta =
                channel === 3
                  ? delta / 255
                  : Math.abs(linear(expected[i + channel]) - linear(actual[i + channel]));
              maxLinearDelta = Math.max(maxLinearDelta, componentDelta);
              changed ||= delta !== 0;
            }
            changedPixels += Number(changed);
          }
          const rmsChannelDelta = Math.sqrt(squaredError / expected.length);
          const factor = 1920 / width;
          const check = {
            frame: diagnostic.frame,
            changedPixels,
            maxChannelDelta,
            maxLinearDelta,
            rmsChannelDelta,
          };
          pixelChecks.push(check);
          console.log(`${language}/${motion}/${width} pixel diagnostic: ${JSON.stringify(check)}`);
          assert(
            maxLinearDelta <= 1 / (factor * factor) + imageBound.linearRoundingMargin &&
              rmsChannelDelta <= imageBound.maxRms8BitChannelDelta &&
              changedPixels <= ((width * width * 9) / 16) * imageBound.maxChangedPixelFraction,
            "Resident GPU differences exceed the driver-rounding bound",
          );
        }
        delete web.diagnostics;
        const renderedFrames = replayFrames - report.geometry.loadingUpdates + 1;
        assert.equal(web.resourceStats.triangles, report.geometry.triangles * renderedFrames);
        assert.equal(native.resourceStats.triangles, report.geometry.triangles * renderedFrames);
        await page
          .locator("#capture")
          .screenshot({ path: resolve(root, `${language}-${motion}-${width}.png`) });
        const result = {
          language,
          motion,
          width,
          ssaa: "1080p",
          pixelSnap: true,
          smoothPan: true,
          residentMeshes: true,
          visibleColors: web.visibleColors,
          parity: pixelChecks.length
            ? "bounded resident GPU driver rounding; raw differing frames retained"
            : "exact native/browser logical hashes for every replay frame",
          pixelChecks,
          native: summarize(native, "native"),
          browser: summarize(web, "browser"),
        };
        report.cases.push(result);
        await writeFile(
          resolve(root, `${language}-${motion}-${width}.raw.json`),
          JSON.stringify({ native, web }),
        );
        await writeFile(resolve(root, "performance.json"), JSON.stringify(report, null, 2) + "\n");
        console.log(
          `${language} ${motion} ${width}: native p95 ${result.native.p95Ms.toFixed(2)} ms; browser p95 ${result.browser.p95Ms.toFixed(2)} ms`,
        );
      }
    }
    await page.close();
  }
  // Both language implementations must produce the same logical pixels too.
  for (const width of [320, 640]) {
    for (const motion of ["pan", "orbit"]) {
      const records = await Promise.all(
        ["odin", "luau"].map(async (language) =>
          JSON.parse(await readFile(resolve(root, `${language}-${motion}-${width}.raw.json`))),
        ),
      );
      assert.deepEqual(
        records[0].native.traces,
        records[1].native.traces,
        `${motion}/${width}: SDK parity`,
      );
      assert.deepEqual(
        records[0].web.traces,
        records[1].web.traces,
        `${motion}/${width}: browser SDK parity`,
      );
    }
  }
  report.performance60Hz = {
    p95WithinBudget: report.cases.every(
      (item) => item.native.p95Ms <= budgetMs && item.browser.p95Ms <= budgetMs,
    ),
    measuredFramesWithinBudget: report.cases.every(
      (item) => item.native.overBudget === 0 && item.browser.overBudget === 0,
    ),
    note: "Correctness passing does not mean the performance budget passed; window/compositor work is additional.",
  };
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  throw error;
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
  await writeFile(resolve(root, "performance.json"), JSON.stringify(report, null, 2) + "\n");
}
