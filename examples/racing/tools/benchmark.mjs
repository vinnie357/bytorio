// Serial measurements of identical fixed-input frames through one player.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { cpus, platform, arch } from "node:os";
import { once } from "node:events";
import { chromium } from "playwright";
import { serve } from "../../../tools/serve.mjs";
import { nativePlayer } from "../../../tools/toolchain.mjs";
import {
  uploadGraphics,
  submitDrawing,
  rasterizeDrawing,
} from "../../../runtime/odin/web/policy.js";
const root = "examples/racing/build/player",
  out = `${root}/benchmark`;
await mkdir(out, { recursive: true });
const masks = (await readFile(`${root}/verification/race.inputs`, "utf8"))
  .trim()
  .split(/\s+/)
  .map(Number)
  .slice(0, 720);
assert.equal(masks.length, 720, "run examples/racing/tools/verify.mjs first");
await writeFile(`${out}/race.inputs`, masks.join("\n") + "\n");
const samples = Number(process.env.RACING_BENCH_SAMPLES || 3);
assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 9);
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
const game = (await WebAssembly.instantiate(await readFile(`${root}/web/game.wasm`), imports))
  .instance.exports;
const runtime = (await WebAssembly.instantiate(await readFile(`${root}/web/runtime.wasm`), imports))
  .instance.exports;
game.game_init();
runtime.runtime_init();
uploadGraphics(game, runtime);
const expected = masks.map((mask) => {
  game.game_update(mask, 0, 0, 0);
  const drawing = submitDrawing(game, runtime);
  rasterizeDrawing(runtime, drawing);
  return { hash: runtime.runtime_hash() >>> 0, sounds: drawing.record.sounds };
});
const reports = {
  native: { odin: [], luauCold: [], luauCached: [] },
  browser: { odin: [], luauCold: [], luauCached: [] },
};
for (let sample = 0; sample < samples; sample++) {
  for (const variant of ["odin", "luauCold", "luauCached"]) {
    const luau = variant !== "odin";
    const args = [
      "--game",
      `${root}/native/${luau ? "luau-executor" : "game"}.wasm`,
      "--benchmark",
      `${out}/race.inputs`,
    ];
    if (luau) {
      args.push(
        "--source",
        `${root}/native/racing.luau`,
        ...(variant === "luauCold" ? ["--no-executor-cache"] : []),
      );
    }
    const result = spawnSync(resolve(`${root}/native/${nativePlayer}`), args, {
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.traces, expected);
    assert.equal(report.timings.length, 720 * 5);
    reports.native[variant].push(report);
    console.log(
      `Native ${variant} ${sample + 1}/${samples}: ${report.startup.totalMs.toFixed(2)} ms startup.`,
    );
  }
}
const server = serve(`${root}/web`, 0);
await once(server, "listening");
const browser = await chromium.launch({
  channel: process.env.PLAYER_BROWSER_CHANNEL || "chrome",
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/comparison.html`);
  await page.evaluate(async () => {
    const { prepareExecutor } = await import("./executor-cache.js");
    await prepareExecutor("./luau-executor.wasm");
  });
  for (let sample = 0; sample < samples; sample++) {
    for (const variant of ["odin", "luauCold", "luauCached"]) {
      const report = await page.evaluate(
        async ({ variant, masks }) => {
          const { prepareExecutor } = await import("./executor-cache.js");
          const executor =
            variant === "odin"
              ? null
              : await prepareExecutor("./luau-executor.wasm", {
                  bypass: variant === "luauCold",
                });
          const worker = new Worker("./worker.js", { type: "module" });
          const next = (expectedType) =>
            new Promise((resolve, reject) => {
              const deadline = setTimeout(() => reject(new Error("Benchmark deadline")), 30000);
              worker.onmessage = ({ data }) => {
                if (data.type !== "error" && data.type !== expectedType) {
                  return;
                }
                clearTimeout(deadline);
                if (data.type === "error") {
                  reject(new Error(data.error));
                } else {
                  resolve(data);
                }
              };
              worker.onerror = reject;
            });
          let pending = next("ready");
          worker.postMessage({
            type: "load",
            gameUrl: variant === "odin" ? "./game.wasm" : "./racing.luau",
            executor,
          });
          const ready = await pending;
          pending = next("benchmark");
          worker.postMessage({ type: "benchmark", masks });
          const report = await pending;
          worker.terminate();
          return { ...report, width: ready.width, height: ready.height };
        },
        { variant, masks },
      );
      assert.equal(report.width, 320);
      assert.equal(report.height, 180);
      assert.deepEqual(report.traces, expected);
      if (variant === "luauCached") {
        assert.ok(report.startup.executorCache.hit);
      }
      reports.browser[variant].push(report);
      console.log(
        `Browser ${variant} ${sample + 1}/${samples}: ${report.startup.totalMs.toFixed(2)} ms startup.`,
      );
    }
  }
  const percentile = (values, p) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
  };
  const summarize = (reports) => {
    const rows = reports.flatMap((r) => r.timings),
      totals = rows.map((row) => row.slice(0, 3).reduce((a, b) => a + b, 0));
    const mean = (index) => rows.reduce((total, row) => total + row[index], 0) / rows.length;
    const median = (fn) => percentile(reports.map(fn), 0.5);
    return {
      startupMedianMs: median((r) => r.startup.totalMs),
      frameMeanMs: totals.reduce((a, b) => a + b, 0) / totals.length,
      frameP95Ms: percentile(totals, 0.95),
      updateMeanMs: mean(0),
      submitMeanMs: mean(1),
      renderMeanMs: mean(2),
      pixelCopyMeanMs: rows[0].length === 4 ? mean(3) : null,
      guestLinearBytes: median((r) => r.memory.currentLinear),
      rendererLinearBytes: reports[0].memory.runtimeLinear ?? null,
      heapPeakBytes: Math.max(...reports.map((r) => r.memory.heapPeak ?? r.memory.peakHeap ?? 0)),
      workingSetMedianBytes: reports[0].memory.working ? median((r) => r.memory.working) : null,
      measuredFrames: rows.length,
    };
  };
  const summary = {
    environment: {
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0].model,
      browser: browser.version(),
      samples,
      display: [320, 180],
      replayFrames: 720,
      warmupPasses: 2,
      measuredPasses: 5,
      nativeFuel: true,
    },
    bytes: {},
    native: {},
    browser: {},
  };
  for (const [name, path] of Object.entries({
    odin: "game.wasm",
    executor: "luau-executor.wasm",
    luau: "racing.luau",
    renderer: "runtime.wasm",
  })) {
    summary.bytes[name] = (await stat(`${root}/web/${path}`)).size;
  }
  for (const target of ["native", "browser"]) {
    for (const variant of ["odin", "luauCold", "luauCached"]) {
      summary[target][variant] = summarize(reports[target][variant]);
    }
  }
  await writeFile(`${out}/raw.json`, JSON.stringify(reports) + "\n");
  await writeFile(`${out}/summary.json`, JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
