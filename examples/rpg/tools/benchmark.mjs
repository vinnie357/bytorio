import { FNV1A_OFFSET_BASIS, FNV1A_PRIME } from "../../../runtime/odin/web/constants.js";
// PROTOTYPE: serial measurements of the same replay through the same player.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { cpus, platform, arch, release } from "node:os";
import { once } from "node:events";
import { chromium } from "../../../tools/browser-timing.mjs";
import { serve } from "../../../tools/serve.mjs";
import { nativePlayer } from "../../../tools/toolchain.mjs";
import {
  loadSource,
  checkExecutor,
  uploadGraphics,
  submitDrawing,
  rasterizeDrawing,
} from "../../../runtime/odin/web/policy.js";

const root = "examples/rpg/build/player",
  out = `${root}/benchmark-batched`;
await mkdir(out, { recursive: true });
const samples = process.argv.includes("--verify")
  ? 1
  : Number(process.env.UNIFIED_BENCH_SAMPLES || 5);
assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 9);
const masks = [];
const tap = (mask) => masks.push(mask, 0),
  walk = (mask, n = 1) => {
    for (let i = 0; i < n; i++) {
      tap(mask);
    }
  };
walk(4);
walk(4);
masks.push(16, ...Array(12).fill(16), 0);
tap(16);
walk(8);
walk(2, 9);
walk(4);
walk(2);
walk(8);
walk(2, 5);
tap(16);
tap(2);
tap(16);
tap(2);
tap(16);
tap(16);
tap(1);
tap(1);
tap(16);
tap(16);
tap(16);
walk(2, 4);
tap(16);
tap(16);
walk(1, 18);
walk(4);
tap(16);
tap(16);
tap(16);
assert.equal(masks.length, 134);
await writeFile(`${out}/quest.inputs`, masks.join("\n") + "\n");
const defeat = [];
for (let i = 0; i < 14; i++) {
  defeat.push(2, 0);
}
defeat.push(2, 0);
for (let i = 0; i < 20; i++) {
  defeat.push(16, 0);
}
defeat.push(16, 0, 4, 0, 16, 0);
assert.equal(defeat.length, 76);
await writeFile(`${out}/defeat.inputs`, defeat.join("\n") + "\n");
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
const wasm = {
  odin: await readFile(`${root}/web/game.wasm`),
  luau: await readFile(`${root}/web/luau-executor.wasm`),
};
const source = await readFile(`${root}/web/rpg.luau`),
  runtimeBytes = await readFile(`${root}/web/runtime.wasm`);
assert.deepEqual(
  WebAssembly.Module.imports(new WebAssembly.Module(wasm.luau)),
  [
    { module: "env", name: "content_size", kind: "function" },
    { module: "env", name: "content_read", kind: "function" },
    { module: "env", name: "save_size", kind: "function" },
    { module: "env", name: "save_status", kind: "function" },
    { module: "env", name: "save_read", kind: "function" },
    { module: "env", name: "text_configure", kind: "function" },
    { module: "env", name: "text_read", kind: "function" },
    { module: "env", name: "save_write", kind: "function" },
  ],
  "executor imports exactly its bounded host interfaces",
);
for (const language of ["odin", "luau"]) {
  assert.deepEqual(
    wasm[language],
    await readFile(`${root}/native/${language === "odin" ? "game" : "luau-executor"}.wasm`),
  );
}
const golden = JSON.parse(await readFile("tests/rpg/parity.json", "utf8"));

async function reference(language, inputs) {
  const game = (await WebAssembly.instantiate(wasm[language], imports)).instance.exports;
  const runtime = (await WebAssembly.instantiate(runtimeBytes, imports)).instance.exports;
  game._initialize?.();
  if (language === "luau") {
    loadSource(game, source);
  }
  game.game_init();
  checkExecutor(game);
  runtime.runtime_init();
  uploadGraphics(game, runtime);
  const frames = [],
    legacy = [];
  for (const mask of inputs) {
    game.game_update(mask, 0, 0, 0);
    const drawing = submitDrawing(game, runtime),
      { record } = drawing;
    rasterizeDrawing(runtime, drawing);
    frames.push({ hash: runtime.runtime_hash() >>> 0, sounds: record.sounds });
    if (language === "odin") {
      // The historical reference covers the original 384×216 artwork.
      const pixels = new Uint8Array(
        runtime.memory.buffer,
        runtime.runtime_pixels(),
        drawing.width * drawing.height * 4,
      );
      let hash = FNV1A_OFFSET_BASIS;
      for (let y = 0; y < 216; y++) {
        for (let x = 0; x < 384 * 4; x++) {
          hash = Math.imul(hash ^ pixels[y * drawing.width * 4 + x], FNV1A_PRIME) >>> 0;
        }
      }
      legacy.push({ hash, sounds: record.sounds });
    }
  }
  if (language === "odin") {
    const state = new Int32Array(game.memory.buffer, game.game_inspect(), 10);
    assert.equal(
      state[7],
      inputs === masks ? 15 : 1,
      "expected complete quest or recovered quest acceptance",
    );
    assert.deepEqual(
      legacy,
      inputs === masks ? golden.quest : golden.defeat,
      "SDK preserves original RPG artwork and sound events",
    );
  }
  return frames;
}
const expected = await reference("odin", masks),
  defeatExpected = await reference("odin", defeat);
assert.deepEqual(await reference("luau", masks), expected);
assert.deepEqual(await reference("luau", defeat), defeatExpected);

function native(language, flags, cacheConfig) {
  const args = ["--game", `${root}/native/${language === "odin" ? "game" : "luau-executor"}.wasm`];
  if (language === "luau") {
    args.push(
      "--source",
      `${root}/native/rpg.luau`,
      ...(cacheConfig ? ["--executor-cache", cacheConfig] : ["--no-executor-cache"]),
    );
  }
  const result = spawnSync(resolve(`${root}/native/${nativePlayer}`), [...args, ...flags], {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  assert.equal(result.status, 0, `${language}: ${result.stderr}`);
  return result.stdout;
}
for (const language of ["odin", "luau"]) {
  const lines = native(language, ["--replay", `${out}/defeat.inputs`])
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.deepEqual(lines, defeatExpected, `${language} native defeat parity`);
  const env = {
    ...process.env,
    SDL_VIDEODRIVER: "dummy",
    SDL_AUDIODRIVER: "dummy",
    SDL_RENDER_DRIVER: "software",
  };
  const args = [
    "--game",
    `${root}/native/${language === "odin" ? "game" : "luau-executor"}.wasm`,
    "--smoke",
    "--capture",
    `${out}/${language}-native.bmp`,
  ];
  if (language === "luau") {
    args.push("--source", `${root}/native/rpg.luau`);
  }
  const smoke = spawnSync(resolve(`${root}/native/${nativePlayer}`), args, {
    env,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(smoke.status, 0, smoke.stderr);
  const report = JSON.parse(smoke.stdout);
  assert.equal(report.ticks, 120);
  assert.equal(report.hash, 1373895059);
  assert.ok(report.audioQueuedFrames > 0);
}
console.log("Parity and native SDL checks passed for both cartridges.");
const nativeResults = {
  metered: { odin: [], luau: [], luauCached: [] },
  unmetered: { odin: [], luau: [], luauCached: [] },
};
const cacheRun = resolve(out, "cache", randomUUID());
let invalidationConfig;
for (const mode of ["metered", "unmetered"]) {
  for (let i = 0; i < samples; i++) {
    for (const language of i % 2 ? ["luau", "odin"] : ["odin", "luau"]) {
      const flags = ["--benchmark", `${out}/quest.inputs`];
      if (mode === "unmetered") {
        flags.push("--benchmark-unmetered");
      }
      let config;
      if (language === "luau") {
        const directory = resolve(cacheRun, `${mode}-${i}`),
          artifacts = resolve(directory, "artifacts");
        await mkdir(artifacts, { recursive: true });
        config = resolve(directory, "cache.toml");
        await writeFile(
          config,
          `[cache]\ndirectory = ${JSON.stringify(artifacts.replaceAll("\\", "/"))}\n`,
        );
        invalidationConfig = config;
      }
      const report = JSON.parse(native(language, flags, config));
      assert.deepEqual(report.traces, expected, `${language} native ${mode} quest parity`);
      assert.equal(report.timings.length, masks.length * 5);
      nativeResults[mode][language].push(report);
      console.log(
        `Native ${mode} ${language} sample ${i + 1}/${samples}: ${report.startup.totalMs.toFixed(1)} ms startup.`,
      );
      if (language === "luau") {
        const cached = JSON.parse(native(language, flags, config));
        assert.deepEqual(cached.traces, expected, "cached native quest parity");
        const directory = resolve(cacheRun, `${mode}-${i}`, "artifacts");
        const files = await readdir(directory, { recursive: true });
        const counts = await Promise.all(
          files
            .filter((name) => name.endsWith(".stats"))
            .map(async (name) =>
              Number(
                (await readFile(resolve(directory, name), "utf8")).match(
                  /usages\s*=\s*(\d+)/,
                )?.[1] || 0,
              ),
            ),
        );
        cached.cacheUsageCount = Math.max(0, ...counts);
        assert.ok(
          cached.executorCacheEnabled && cached.cacheUsageCount >= 2,
          "Wasmtime cache metadata confirms a reused artifact",
        );
        nativeResults[mode].luauCached.push(cached);
        console.log(
          `Native ${mode} luau cached sample ${i + 1}/${samples}: ${cached.startup.totalMs.toFixed(1)} ms startup.`,
        );
      }
    }
  }
}
const changed = spawnSync(
  resolve(`${root}/native/${nativePlayer}`),
  [
    "--game",
    "examples/rpg/build/odin/web/fixtures/abi.wasm",
    "--source",
    `${root}/native/rpg.luau`,
    "--executor-cache",
    invalidationConfig,
    "--check",
  ],
  { encoding: "utf8", timeout: 10000 },
);
assert.equal(changed.status, 1);
assert.match(
  changed.stderr,
  /unsupported game ABI/,
  "native cache does not substitute old code for a different module",
);

const server = serve(`${root}/web`, 0);
await once(server, "listening");
let browser;
const browserResults = { odin: [], luau: [], luauCached: [] };
try {
  browser = await chromium.launch({
    channel: process.env.PLAYER_BROWSER_CHANNEL || undefined,
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } }),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const language of ["odin", "luau"]) {
    await page.goto(`${base}/debug.html${language === "luau" ? "?game=./rpg.luau" : ""}`);
    await page.waitForFunction(() => playerStatus.ready || playerStatus.error);
    assert.equal(await page.evaluate(() => playerStatus.error), "");
    await page.getByRole("button", { name: "Start game" }).click();
    const initial = await page.evaluate(() => playerStatus.hash);
    await page.keyboard.down("ArrowUp");
    await page.waitForFunction((hash) => playerStatus.hash !== hash, initial);
    await page.keyboard.up("ArrowUp");
    await page.keyboard.down("Space");
    await page.waitForFunction(() => playerStatus.sounds >= 2);
    await page.keyboard.up("Space");
    assert.ok(await page.evaluate(() => playerAudio.played >= 2 && playerAudio.peak > 0.1));
    await page.screenshot({ path: `${out}/${language}-browser.png` });
  }
  await page.goto(`${base}/comparison.html`);
  const primed = await page.evaluate(async () => {
    const { prepareExecutor } = await import("./executor-cache.js");
    return (await prepareExecutor("./luau-executor.wasm")).cache;
  });
  console.log(`Browser executor cache scope: ${primed.scope}; ${primed.fallback || "ready"}`);
  for (let i = 0; i < samples; i++) {
    for (const variant of i % 2 ? ["luauCached", "luau", "odin"] : ["odin", "luau", "luauCached"]) {
      const language = variant === "odin" ? "odin" : "luau";
      const result = await page.evaluate(
        async ({ language, variant, masks, defeat }) => {
          const started = performance.now();
          const { prepareExecutor } = await import("./executor-cache.js");
          const executor =
            language === "luau"
              ? await prepareExecutor("./luau-executor.wasm", { bypass: variant === "luau" })
              : null;
          const worker = new Worker("./worker.js", { type: "module" });
          try {
            const exchange = (message, expectedType) =>
              new Promise((resolve, reject) => {
                const timeout = setTimeout(
                  () => reject(new Error("Unified Worker benchmark timeout")),
                  90000,
                );
                worker.onerror = (event) => {
                  clearTimeout(timeout);
                  reject(new Error(event.message));
                };
                worker.onmessage = ({ data }) => {
                  if (data.type !== "error" && data.type !== expectedType) {
                    return;
                  }
                  clearTimeout(timeout);
                  data.type === "error" ? reject(new Error(data.error)) : resolve(data);
                };
                worker.postMessage(message);
              });
            const ready = await exchange(
              {
                type: "load",
                gameUrl: language === "luau" ? "./rpg.luau" : "./game.wasm",
                executor,
              },
              "ready",
            );
            if (ready.ticks !== 0 || ready.sounds !== 1) {
              throw new Error("Cartridge state leaked across cached instances.");
            }
            const workerReadyMs = performance.now() - started;
            const benchmark = await exchange({ type: "benchmark", masks }, "benchmark");
            // Restart the same instance, then check the separate defeat route.
            const recovered = await exchange({ type: "benchmark", masks: defeat }, "benchmark");
            return {
              ...benchmark,
              workerReadyMs,
              initialMemory: ready.memory,
              defeatTraces: recovered.traces,
            };
          } finally {
            worker.terminate();
          }
        },
        { language, variant, masks, defeat },
      );
      assert.deepEqual(result.traces, expected, `${language} browser quest parity`);
      assert.deepEqual(result.defeatTraces, defeatExpected, `${language} browser defeat parity`);
      if (variant === "luauCached") {
        assert.equal(
          result.startup.executorCache.hit,
          true,
          "fresh game Worker reuses compiled executor",
        );
        assert.equal(
          result.startup.executorCache.downloadedExecutor,
          false,
          "cache hit does not download the executor again",
        );
      }
      if (variant === "luau") {
        assert.equal(
          result.startup.executorCache.hit,
          false,
          "cold control bypasses the module cache",
        );
      }
      browserResults[variant].push(result);
      console.log(
        `Browser ${variant} sample ${i + 1}/${samples}: ${result.startup.totalMs.toFixed(1)} ms startup.`,
      );
    }
  }
  const browserInvalidation = await page.evaluate(async () => {
    const { prepareExecutor } = await import("./executor-cache.js");
    const first = await prepareExecutor("./luau-executor.wasm");
    const response = await fetch("./luau-executor.wasm");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const changed = new Uint8Array(bytes.length + 3);
    changed.set(bytes);
    changed.set([0, 1, 0], bytes.length);
    const url = URL.createObjectURL(new Blob([changed]));
    try {
      const next = await prepareExecutor(url);
      return {
        old: first.cache.key,
        next: next.cache.key,
        hit: next.cache.hit,
        scope: next.cache.scope,
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  });
  assert.notEqual(browserInvalidation.old, browserInvalidation.next);
  assert.equal(browserInvalidation.hit, false, "changed bytes invalidate browser module cache");
  // Diagnostics must survive the C++ -> Wasm -> player boundary.
  const bad =
    'return {init=function() error("prototype diagnostic") end, update=function() end, draw=function() end}';
  await writeFile(`${root}/web/diagnostic.luau`, bad);
  const failure = spawnSync(
    resolve(`${root}/native/${nativePlayer}`),
    [
      "--game",
      `${root}/native/luau-executor.wasm`,
      "--source",
      `${root}/web/diagnostic.luau`,
      "--check",
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /prototype diagnostic/);
  await page.goto(`${base}/debug.html?game=./diagnostic.luau`);
  await page.waitForFunction(() => !!playerStatus.error);
  assert.match(await page.evaluate(() => playerStatus.error), /prototype diagnostic/);
  assert.deepEqual(errors, []);
  const report = {
    environment: {
      platform: platform(),
      arch: arch(),
      os: release(),
      cpu: cpus()[0].model,
      browser: browser.version(),
      samples,
      warmupPasses: 2,
      measuredPasses: 5,
      questTicks: 134,
      defeatTicks: 76,
    },
    bytes: {
      odinModule: wasm.odin.length,
      luauExecutor: wasm.luau.length,
      luauCartridge: source.length,
      runtime: runtimeBytes.length,
      player: (await stat(`${root}/native/${nativePlayer}`)).size,
    },
    native: nativeResults,
    browser: browserResults,
  };
  await writeFile(`${out}/raw.json`, JSON.stringify(report) + "\n");
  const percentile = (values, p) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
  };
  const summarize = (reports) => {
    const rows = reports.flatMap((r) => r.timings),
      frames = rows.map((row) => row.slice(0, 3).reduce((a, b) => a + b, 0));
    const mean = (index) => rows.reduce((sum, row) => sum + row[index], 0) / rows.length;
    const median = (fn) => percentile(reports.map(fn), 0.5);
    return {
      startupMedianMs: median((r) => r.startup.totalMs),
      compileMedianMs: median((r) => r.startup.compileMs),
      gameInitMedianMs: median((r) => r.startup.gameInitMs),
      frameMeanMs: frames.reduce((a, b) => a + b, 0) / frames.length,
      frameP50Ms: percentile(frames, 0.5),
      frameP95Ms: percentile(frames, 0.95),
      updateMeanMs: mean(0),
      submitMeanMs: mean(1),
      renderMeanMs: mean(2),
      pixelCopyMeanMs: rows[0].length > 3 ? mean(3) : null,
      guestLinearBytes: median((r) => r.memory.currentLinear),
      heapPeakBytes: !reports[0].memory.heapBytes
        ? null
        : Math.max(...reports.map((r) => r.memory.heapPeak)),
      workingSetMedianBytes: reports[0].memory.working ? median((r) => r.memory.working) : null,
      peakWorkingSetBytes: reports[0].memory.peakWorking
        ? Math.max(...reports.map((r) => r.memory.peakWorking))
        : null,
      frameSamples: rows.length,
    };
  };
  const summary = {
    environment: report.environment,
    bytes: report.bytes,
    native: { metered: {}, unmetered: {} },
    browser: {},
  };
  for (const mode of ["metered", "unmetered"]) {
    for (const language of ["odin", "luau", "luauCached"]) {
      summary.native[mode][language] = summarize(nativeResults[mode][language]);
    }
  }
  for (const language of ["odin", "luau", "luauCached"]) {
    summary.browser[language] = summarize(browserResults[language]);
  }
  await writeFile(`${out}/summary.json`, JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
