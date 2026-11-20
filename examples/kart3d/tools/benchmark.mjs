import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { cpus, platform, arch, totalmem } from "node:os";
import { chromium } from "../../../tools/browser-timing.mjs";
import { serve } from "../../../tools/serve.mjs";
import { run, nativePlayer } from "../../../tools/toolchain.mjs";
import { course } from "./course.mjs";
import * as policy from "../../../runtime/odin/web/policy.js";

const root = resolve("examples/kart3d/build/benchmarks", randomUUID());
const qualityMatrix = process.argv.includes("--quality-matrix");
const warmupFrames = qualityMatrix ? 240 : 0;
const displays = qualityMatrix
  ? [
      [320, 180],
      [640, 360],
    ]
  : [[320, 180]];
const qualities = qualityMatrix ? ["off", "2x", "1080p"] : ["off"];
const resumeAt = process.argv.indexOf("--resume");
const previous = resumeAt < 0 ? null : JSON.parse(await readFile(process.argv[resumeAt + 1]));
if (previous) {
  assert.equal(previous.method.simulationOnlyPrefix, warmupFrames);
  assert.equal(previous.method.frames, 300);
  assert.equal(previous.method.measuredPasses, 5);
}
await mkdir(root, { recursive: true });
const imports = {
  env: {
    sin: Math.sin,
    content_size: () => 0,
    content_read: () => 0,
    save_size: () => 0,
    save_status: () => 3,
    save_read: () => 0,
    save_write: () => 3,
    text_configure: () => 0,
    text_read: () => 0,
  },
};
const game = (
  await WebAssembly.instantiate(
    await readFile("examples/kart3d/build/odin/build/web/game.wasm"),
    imports,
  )
).instance.exports;
const runtime = (
  await WebAssembly.instantiate(
    await readFile("examples/kart3d/build/odin/build/web/runtime.wasm"),
    imports,
  )
).instance.exports;
game._initialize?.();
runtime.runtime_init();
policy.configureResources(game, runtime);
game.game_init();
policy.submitResources(game, runtime);
const masks = [];
for (let i = 0; i < 300; i++) {
  const s = new Int32Array(game.memory.buffer, game.game_inspect(), 26);
  const curve = course[Math.floor(s[2] / 1024) % 96][5];
  const correction =
    Math.max(-35, Math.min(35, -s[3] / 14)) - s[4] + Math.floor((curve * s[5]) / 1024);
  const mask = 4 | (correction > 1 ? 2 : correction < -1 ? 1 : 0);
  masks.push(mask);
  policy.deliverResources(game, runtime);
  game.game_update(mask, 0, 0, 0);
  policy.checkExecutor(game);
  policy.submitResources(game, runtime);
}
const server = serve(".", 0);
await once(server, "listening");
const browser = await chromium.launch({
  channel: process.env.PLAYER_BROWSER_CHANNEL || "chrome",
});
const report = {
  status: "running",
  recordedAt: new Date().toISOString(),
  hardware: {
    cpu: cpus()[0].model,
    logicalProcessors: cpus().length,
    memoryBytes: totalmem(),
    platform: platform(),
    arch: arch(),
    browser: browser.version(),
  },
  method: {
    frames: 300,
    warmupPasses: 2,
    measuredPasses: 5,
    excludedCountdownFrames: 180,
    simulationOnlyPrefix: warmupFrames,
    scope:
      "Seven sequential race starts, two warmup passes and five measured passes. The quality matrix advances 240 simulation updates without drawing, then measures 60 moving frames per pass. The baseline measures 120 moving frames after countdown. Timings include GPU completion/bitmap creation when selected, exclude diagnostic hashes, main-thread delivery, audio and scanout. Throughput is computed work rate, not delivered display FPS. Native startup ends after first draw submission (complete on CPU); browser startup includes its first frame and uses the executor byte fallback, without the launcher module cache. Native executor and OS/browser caches are retained. This short rollout does not qualify the complete course or minimum hardware.",
  },
  cases: [],
};
const cpuReferences = new Map();
const quantile = (a, q) =>
  [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))];
function summary(value) {
  const frames = qualityMatrix ? value.timings : value.timings.filter((_, i) => i % 300 >= 180);
  const total = frames.map((row) => row.reduce((a, b) => a + b, 0));
  return {
    samples: total.length,
    p50Ms: quantile(total, 0.5),
    p95Ms: quantile(total, 0.95),
    p99Ms: quantile(total, 0.99),
    meanMs: total.reduce((a, b) => a + b, 0) / total.length,
    workFramesPerSecond: (1000 * total.length) / total.reduce((a, b) => a + b, 0),
    deliveredFramesPerSecond: null,
    maxMs: Math.max(...total),
    over60HzBudget: total.filter((v) => v > 1000 / 60).length,
    stageP95Ms: frames[0].map((_, i) =>
      quantile(
        frames.map((row) => row[i]),
        0.95,
      ),
    ),
    startup: value.startup,
    memory: value.memory,
    resourceStats: value.resourceStats,
    gpuStats: value.gpuStats,
    cpuStats: value.cpuStats,
  };
}
try {
  const page = await browser.newPage();
  report.hardware.webglRenderer = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) {
      return null;
    }
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const name = gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return name;
  });
  if (previous) {
    assert.deepEqual(
      report.hardware,
      previous.hardware,
      "Resume requires matching hardware/browser",
    );
  }
  for (const language of ["odin", "luau"]) {
    const base = resolve("examples/kart3d/build", language, "build");
    const artifactFiles = [
      "game.png",
      "runtime.wasm",
      "runtime-gpu.wasm",
      "worker.js",
      "policy.js",
      "gpu.js",
      "constants.js",
    ];
    if (language === "luau") {
      artifactFiles.push("luau-executor.wasm");
    }
    const artifacts = {};
    for (const file of [...artifactFiles.map((name) => `web/${name}`), `native/${nativePlayer}`]) {
      artifacts[file] = createHash("sha256")
        .update(await readFile(resolve(base, file)))
        .digest("hex");
    }
    const web = "/" + relative(process.cwd(), resolve(base, "web")).replaceAll("\\", "/");
    await page.goto(`http://127.0.0.1:${server.address().port}${web}/player.html`);
    for (const backend of ["cpu", "gpu"]) {
      for (const display of displays) {
        const replayMasks = masks.map(
          (mask, i) => mask | (i === 0 && display[0] === 640 ? 8192 : 0),
        );
        const input = resolve(root, `start-${display[0]}.inputs`);
        await writeFile(input, replayMasks.join("\n") + "\n");
        for (const ssaa of qualities) {
          const name = `${language}-${backend}-${display[0]}-${ssaa}`;
          const retained = previous?.cases.find(
            (row) =>
              row.language === language &&
              row.backend === backend &&
              row.display[0] === display[0] &&
              row.ssaa === ssaa,
          );
          if (
            retained?.artifacts &&
            JSON.stringify(retained.artifacts) === JSON.stringify(artifacts)
          ) {
            const retainedSource =
              retained.retainedFrom || previous.resumeSource || process.argv[resumeAt + 1];
            report.cases.push({
              ...retained,
              retainedFrom: relative(process.cwd(), resolve(retainedSource)),
            });
            if (backend === "cpu") {
              const raw = JSON.parse(await readFile(resolve(retainedSource, "..", `${name}.json`)));
              assert.deepEqual(raw.native.traces, raw.browser.traces);
              cpuReferences.set(`${display[0]}-${ssaa}`, raw.native.traces);
            }
            console.log(`Reused verified unchanged ${name}`);
            continue;
          }
          console.log(`Starting ${name}`);
          const native = JSON.parse(
            run(
              resolve(base, `native/${nativePlayer}`),
              [
                "--benchmark",
                input,
                "--benchmark-warmup",
                String(warmupFrames),
                "--renderer",
                backend,
                "--ssaa",
                ssaa,
                ...(backend === "gpu" ? ["--gpu-meshes"] : []),
              ],
              {
                timeout: 300000,
                env: {
                  ...process.env,
                  ...(backend === "cpu" ? { SDL_VIDEODRIVER: "dummy" } : {}),
                },
              },
            ),
          );
          await writeFile(resolve(root, `${name}-native.json`), JSON.stringify(native, null, 2));
          const result = await page.evaluate(
            async ({ web, masks, backend, ssaa, warmupFrames }) => {
              const worker = new globalThis.Worker(web + "/worker.js", { type: "module" });
              const request = (message, type) =>
                new Promise((resolve, reject) => {
                  const timer = setTimeout(
                    () => reject(new Error("Kart benchmark deadline")),
                    300000,
                  );
                  worker.onerror = (event) => {
                    clearTimeout(timer);
                    reject(new Error(event.message));
                  };
                  worker.onmessage = async ({ data }) => {
                    if (data.type === "executor") {
                      const bytes = await (await fetch(web + "/luau-executor.wasm")).arrayBuffer();
                      worker.postMessage({ type: "executor", executor: { bytes } }, [bytes]);
                    } else if (data.type === "error") {
                      clearTimeout(timer);
                      reject(new Error(data.error));
                    } else if (data.type === type) {
                      clearTimeout(timer);
                      data.bitmap?.close();
                      resolve(data);
                    }
                  };
                  worker.postMessage(message);
                });
              try {
                const ready = await request(
                  {
                    type: "load",
                    gameUrl: globalThis.location.origin + web + "/game.png",
                    graphics: { backend, ssaa, residentMeshes: backend === "gpu" },
                  },
                  "ready",
                );
                if (ready.graphics.effective !== backend) {
                  throw new Error("Wrong benchmark renderer");
                }
                return await request({ type: "benchmark", masks, warmupFrames }, "benchmark");
              } finally {
                worker.terminate();
              }
            },
            { web, masks: replayMasks, backend, ssaa, warmupFrames },
          );
          await writeFile(
            resolve(root, `${name}.json`),
            JSON.stringify({ native, browser: result }, null, 2),
          );
          assert.equal(native.timings.length, 5 * (300 - warmupFrames));
          assert.equal(result.timings.length, native.timings.length);
          if (backend === "cpu") {
            assert.deepEqual(
              native.traces,
              result.traces,
              `${language}/${backend}: measured replay output`,
            );
            const key = `${display[0]}-${ssaa}`;
            const reference = cpuReferences.get(key);
            if (reference) {
              assert.deepEqual(native.traces, reference, `${name}: SDK pixels/sounds`);
            } else {
              cpuReferences.set(key, native.traces);
            }
          } else {
            assert.deepEqual(
              native.traces.map((x) => x.sounds),
              result.traces.map((x) => x.sounds),
            );
          }
          const row = {
            language,
            backend,
            display,
            ssaa,
            artifacts,
            cartridgeBytes: (await readFile(resolve(base, "game.png"))).length,
            native: summary(native),
            browser: summary(result),
          };
          report.cases.push(row);
          console.log(
            `${name}: native p95 ${row.native.p95Ms.toFixed(2)} ms; browser p95 ${row.browser.p95Ms.toFixed(2)} ms`,
          );
          await writeFile(resolve(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
        }
      }
    }
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  throw error;
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
  await writeFile(resolve(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(`Kart benchmark: ${relative(process.cwd(), root)}`);
