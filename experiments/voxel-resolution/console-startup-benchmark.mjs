import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { serve } from "../../tools/serve.mjs";
import {
  run,
  tool,
  repo,
  dependencyRoot,
  nativePlayer,
  nativeLinkerFlags,
  copySdlLibrary,
  copyWasmtimeLibrary,
} from "../../tools/toolchain.mjs";

const folder = resolve("build/riverside-startup");
const sceneRoot = resolve("build/compact-3d/riverside");
const geometry = JSON.parse(await readFile(resolve(sceneRoot, "geometry.json")));
const samples = 3;
const report = {
  status: "running",
  recordedAt: new Date().toISOString(),
  revision: run("git", ["rev-parse", "HEAD"]).trim(),
  cpu: cpus()[0].model,
  method: {
    samples,
    loadingUpdates: geometry.loadingUpdates,
    fixedHz: 60,
    native:
      "Fresh process of speed-optimized production player source with timing probes only; smoke mode uses real elapsed time and neutral input; exits after first full scene is presented. SDL audio uses dummy device. Timings begin at run entry, excluding OS process/DLL-loader overhead. Window presentation included; scanout unmeasured.",
    browser:
      "Local HTTP, fresh contexts, same-context reloads, and same-page restarts. Only same-page restarts reuse the application executor-module cache. Navigation-to-ready includes module fetch and GPU initialization. Start is clicked automatically; click-to-scene includes fixed 60 Hz loading. Mutation observer records after main-thread canvas/frame handler. Same-page times start at restart click. OS, browser engine and GPU driver caches are not flushed; Internet latency is not simulated.",
    gpu: "GPU resident meshes, 1080p SSAA, snapped camera and smooth pan at 320x180 output",
    cpu: "Default CPU renderer, SSAA off, no snapping or smooth pan",
  },
  sizes: {},
  native: [],
  browser: [],
};
const hash = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
for (const language of ["odin", "luau"]) {
  const base = resolve(sceneRoot, language, "build/web");
  report.sizes[language] = {};
  for (const name of [
    "game.png",
    "runtime.wasm",
    "runtime-gpu.wasm",
    ...(language === "luau" ? ["luau-executor.wasm"] : []),
  ]) {
    const bytes = await readFile(resolve(base, name));
    report.sizes[language][name] = {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
}
try {
  if (!process.argv.includes("--browser-only")) {
    const sourceFolder = resolve(folder, "native-source");
    const binaryFolder = resolve(folder, "native-bin");
    await mkdir(sourceFolder, { recursive: true });
    await mkdir(binaryFolder, { recursive: true });
    for (const name of await readdir("runtime/odin/native")) {
      if (!name.endsWith(".odin")) {
        continue;
      }
      let source = await readFile(resolve("runtime/odin/native", name), "utf8");
      source = source.replaceAll('"../', '"console_runtime:');
      if (name === "main.odin") {
        const replace = (before, after) => {
          assert(source.includes(before), `missing native probe anchor: ${before}`);
          source = source.replace(before, after);
        };
        replace(
          "run :: proc() -> int {",
          "run :: proc() -> int {\n    probe_start := clock_ms()\n    probe_blank_ms: f64",
        );
        replace(
          "    if packaged && app.game.display_mode != cart.display {",
          "    probe_blank_ms = clock_ms() - probe_start\n    if packaged && app.game.display_mode != cart.display {",
        );
        replace("accumulator += 1.0 / 60.0", "accumulator += delta");
        replace("keys = abi.smoke_input(app.frame.ticks)", "keys = {}");
        const stop = "        if (smoke || check_only) && app.frame.ticks >= 120 {";
        const probeFormat =
          'STARTUP_PROBE {{"blankMs":%.6f,"sceneMs":%.6f,"compileMs":%.6f,"instantiateMs":%.6f,"gameInitMs":%.6f,"ticks":%d,"hash":%d,"triangles":%d}}\n';
        replace(
          stop,
          `        if (smoke || check_only) && app.frame.ticks >= ${geometry.loadingUpdates} {
            fmt.printf(${JSON.stringify(probeFormat)}, probe_blank_ms, clock_ms() - probe_start, app.game.compile_ms, app.game.instantiate_ms, app.game.initialize_ms, app.frame.ticks, core.hash(), app.game.resources.stats.triangles)
`,
        );
      }
      await writeFile(resolve(sourceFolder, name), source);
    }
    const exe = resolve(binaryFolder, nativePlayer);
    console.log("Building instrumented native startup observer.");
    run(
      tool("odin"),
      [
        "build",
        sourceFolder,
        "-o:speed",
        "-source-code-locations:filename",
        `-out:${exe}`,
        `-collection:console_runtime=${resolve(repo, "runtime/odin")}`,
        `-collection:deps=${dependencyRoot()}`,
        ...nativeLinkerFlags({ harness: true }),
      ],
      { timeout: 180000 },
    );
    await copySdlLibrary(binaryFolder);
    await copyWasmtimeLibrary(binaryFolder);
    report.nativeObserver = {
      sha256: await hash(exe),
      sourcePlayerSha256: await hash(resolve(sceneRoot, `odin/build/native/${nativePlayer}`)),
    };
    for (const language of ["odin", "luau"]) {
      for (const backend of ["cpu", "gpu"]) {
        for (const cache of language === "luau" ? ["disabled", "warm"] : ["disabled"]) {
          const args = [
            "--game",
            resolve(sceneRoot, language, "build/game.png"),
            "--executor",
            resolve(sceneRoot, "luau/build/web/luau-executor.wasm"),
            "--smoke",
            "--renderer",
            backend,
          ];
          if (cache === "disabled") {
            args.push("--no-executor-cache");
          }
          if (backend === "gpu") {
            args.push("--gpu-meshes", "--ssaa", "1080p", "--smooth-pan");
          }
          const take = () => {
            const out = run(exe, args, {
              timeout: 30000,
              env: { ...process.env, SDL_AUDIODRIVER: "dummy" },
            });
            const line = out.split("\n").find((s) => s.startsWith("STARTUP_PROBE "));
            assert(line, "native startup probe not emitted");
            const record = JSON.parse(line.slice("STARTUP_PROBE ".length));
            assert(
              record.ticks >= geometry.loadingUpdates && record.triangles >= geometry.triangles,
            );
            return record;
          };
          if (cache === "warm") {
            take();
          }
          const records = Array.from({ length: samples }, take);
          report.native.push({
            language,
            backend,
            executorCache: cache,
            blankMedianMs: median(records.map((r) => r.blankMs)),
            sceneMedianMs: median(records.map((r) => r.sceneMs)),
            records,
          });
          console.log(
            `native ${language}/${backend}/${cache}: scene ${report.native.at(-1).sceneMedianMs.toFixed(1)} ms`,
          );
        }
      }
    }
  } else {
    const previous = JSON.parse(await readFile(resolve(folder, "report.json")));
    assert.equal(
      previous.revision,
      report.revision,
      "native results must use the current revision",
    );
    assert.equal(
      previous.nativeObserver.sourcePlayerSha256,
      await hash(resolve(sceneRoot, `odin/build/native/${nativePlayer}`)),
    );
    report.native = previous.native;
    report.nativeObserver = previous.nativeObserver;
    report.nativeRecordedAt = previous.recordedAt;
  }
  // Timing probes must preserve the stock player's first complete scene.
  const replay = resolve(folder, "still.inputs");
  await writeFile(replay, "0\n".repeat(geometry.loadingUpdates));
  report.stockPlayerChecks = [];
  for (const language of ["odin", "luau"]) {
    for (const backend of ["cpu", "gpu"]) {
      const args = ["--replay", replay, "--renderer", backend];
      if (backend === "gpu") {
        args.push("--gpu-meshes", "--ssaa", "1080p", "--smooth-pan");
      }
      const output = run(resolve(sceneRoot, language, `build/native/${nativePlayer}`), args);
      const last = JSON.parse(output.trim().split("\n").at(-1));
      const observed = report.native.find(
        (record) => record.language === language && record.backend === backend,
      );
      for (const sample of observed.records) {
        assert.equal(last.hash, sample.hash, "startup observer must preserve stock player pixels");
      }
      report.stockPlayerChecks.push({ language, backend, hash: last.hash, matched: true });
    }
  }
  const server = serve(".", 0);
  await once(server, "listening");
  const browser = await chromium
    .launch({ channel: process.env.PLAYER_BROWSER_CHANNEL || "chrome" })
    .catch(async (error) => {
      await new Promise((done) => server.close(done));
      throw error;
    });
  report.browserVersion = browser.version();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const measure = async (page, url, restart = false) => {
    if (!restart) {
      await page.goto(url);
    }
    await page.waitForFunction(() => window.playerStatus?.ready || window.playerStatus?.error);
    assert.equal(await page.evaluate(() => window.playerStatus.error), "");
    await page.locator(restart ? "#graphics-apply" : "#start").click();
    await page.waitForFunction(
      () => window.startupProbe?.sceneAt || window.playerStatus?.error,
      null,
      { timeout: 30000 },
    );
    const data = await page.evaluate(() => ({
      ...window.startupProbe,
      startup: window.playerStatus.startup,
      metrics: window.playerStatus.metrics,
    }));
    assert(data.sceneAt && data.sceneHash !== data.blankHash);
    return {
      ...data,
      readyMs: data.readyAt - (data.baseAt || 0),
      clickToSceneMs: data.sceneAt - data.clickAt,
      navigationToSceneMs: data.sceneAt - (data.baseAt || 0),
      loadAction: restart ? "restart-current-page" : "navigation-then-start",
    };
  };
  try {
    for (const language of ["odin", "luau"]) {
      for (const backend of ["cpu", "gpu"]) {
        for (const cache of ["fresh-context", "warm-reload", "same-page-restart"]) {
          const records = [];
          for (let sample = 0; sample < samples; sample++) {
            const context = await browser.newContext({ viewport: { width: 1952, height: 1230 } });
            await context.addInitScript(
              ({ loadingUpdates }) => {
                window.startupProbe = {};
                document.addEventListener(
                  "click",
                  (event) => {
                    if (event.target.id === "graphics-apply") {
                      const now = performance.now();
                      window.startupProbe = { clickAt: now, baseAt: now };
                    } else if (event.target.id === "start") {
                      window.startupProbe.clickAt = performance.now();
                    }
                  },
                  true,
                );
                const install = () => {
                  const observer = new MutationObserver(() => {
                    const status = window.playerStatus,
                      probe = window.startupProbe;
                    if (status?.ready && !probe.readyAt) {
                      probe.readyAt = performance.now();
                      probe.blankHash = status.hash;
                    }
                    if (status?.ticks >= loadingUpdates && !probe.sceneAt) {
                      probe.sceneAt = performance.now();
                      probe.ticks = status.ticks;
                      probe.sceneHash = status.hash;
                    }
                  });
                  observer.observe(document.getElementById("status"), {
                    subtree: true,
                    childList: true,
                    characterData: true,
                  });
                };
                document.addEventListener("DOMContentLoaded", install, { once: true });
              },
              { loadingUpdates: geometry.loadingUpdates },
            );
            const page = await context.newPage();
            const query =
              backend === "gpu"
                ? "renderer=gpu&gpu-meshes&ssaa=1080p&smooth-pan"
                : "renderer=cpu&ssaa=off";
            const url = `${origin}/build/compact-3d/riverside/${language}/build/web/debug.html?${query}`;
            if (cache !== "fresh-context") {
              await measure(page, url);
            }
            const record = await measure(page, url, cache === "same-page-restart");
            if (language === "luau") {
              assert.equal(record.startup.executorCache.hit, cache === "same-page-restart");
            }
            if (backend === "cpu") {
              const stock = report.stockPlayerChecks.find(
                (entry) => entry.language === language && entry.backend === backend,
              );
              assert.equal(
                record.sceneHash,
                stock.hash,
                "browser CPU first scene must match stock native pixels",
              );
            } else {
              assert.equal(
                record.metrics.meshUploads,
                Math.ceil(geometry.worldQuads / geometry.facesPerUpload) + 1,
              );
            }
            records.push(record);
            await context.close();
          }
          report.browser.push({
            language,
            backend,
            cache,
            readyMedianMs: median(records.map((r) => r.readyMs)),
            clickToSceneMedianMs: median(records.map((r) => r.clickToSceneMs)),
            navigationToSceneMedianMs: median(records.map((r) => r.navigationToSceneMs)),
            records,
          });
          const latest = report.browser.at(-1);
          console.log(
            `browser ${language}/${backend}/${cache}: ready ${latest.readyMedianMs.toFixed(1)} ms, click-to-scene ${latest.clickToSceneMedianMs.toFixed(1)} ms`,
          );
        }
      }
    }
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
  for (const backend of ["cpu", "gpu"]) {
    const odin = report.browser.find(
      (record) => record.language === "odin" && record.backend === backend,
    );
    const expected = odin.records[0].sceneHash;
    for (const group of report.browser.filter((record) => record.backend === backend)) {
      for (const sample of group.records) {
        assert.equal(
          sample.sceneHash,
          expected,
          "SDKs must show the same first scene on each browser backend",
        );
      }
    }
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  throw error;
} finally {
  await writeFile(resolve(folder, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
