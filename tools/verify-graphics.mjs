import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { timedSpawnSync as spawnSync } from "./command-timing.mjs";
import { once } from "node:events";
import { chromium } from "./browser-timing.mjs";
import { createProject, buildProject, requireNativePlayer } from "./sdk/project.mjs";
import { serve } from "./serve.mjs";
import { tool, task, copyWasmtimeLibrary, nativePlayer } from "./toolchain.mjs";
import {
  configureResources,
  submitResources,
  deliverResources,
  loadSource,
  uploadGraphics,
  submitDrawing,
  rasterizeDrawing,
  checkExecutor,
} from "../runtime/odin/web/policy.js";
requireNativePlayer();

const root = resolve("build/graphics-verification", randomUUID());
await mkdir(root, { recursive: true });
function run(exe, args, expected = 0) {
  const result = spawnSync(exe, args, {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, expected, result.stderr || result.stdout || String(result.error));
  return result;
}
const odin = tool("odin");
run(odin, ["test", "tests/graphics", "-o:none", `-out:${resolve(root, "renderer-tests.exe")}`]);
task("deps:trace:graphics");
await copyFile("build/validation-tools/graphics/trace.exe", resolve(root, "trace.exe"));
await copyWasmtimeLibrary(root);
const projects = {},
  references = {},
  benchmarks = {};
await writeFile(resolve(root, "replay.txt"), Array(12).fill("0").join("\n"));
for (const language of ["odin", "luau"]) {
  const project = resolve(root, language);
  await createProject(project, language);
  const manifest = JSON.parse(await readFile(resolve(project, "console.json")));
  manifest.display = [320, 180];
  await writeFile(resolve(project, "console.json"), JSON.stringify(manifest));
  await copyFile(
    `examples/resources/graphics/${language}/main.${language}`,
    resolve(project, `src/main.${language}`),
  );
  await buildProject(project);
  projects[language] = project;
  const base = resolve(project, "build/web");
  const wasm = resolve(base, language === "luau" ? "luau-executor.wasm" : "game.wasm");
  const source = language === "luau" ? resolve(base, "game.luau") : null;
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
  const game = (await WebAssembly.instantiate(await readFile(wasm), imports)).instance.exports;
  const runtime = (
    await WebAssembly.instantiate(await readFile(resolve(base, "runtime.wasm")), imports)
  ).instance.exports;
  game._initialize?.();
  if (source) {
    loadSource(game, await readFile(source));
  }
  runtime.runtime_init();
  configureResources(game, runtime);
  game.game_init();
  checkExecutor(game);
  submitResources(game, runtime);
  uploadGraphics(game, runtime);
  const frames = [];
  for (let tick = 0; tick <= 12; tick++) {
    if (tick) {
      deliverResources(game, runtime);
      game.game_update(0, tick === 10 ? 1 : 0, tick === 10 ? 500 : 0, 50);
      checkExecutor(game);
      submitResources(game, runtime);
    }
    const drawing = submitDrawing(game, runtime);
    rasterizeDrawing(runtime, drawing);
    const pixels = Buffer.from(
      new Uint8Array(
        runtime.memory.buffer,
        runtime.runtime_pixels(),
        drawing.width * drawing.height * 4,
      ),
    );
    assert.equal(
      pixels.readUInt32LE(0),
      tick >= 4 && tick <= 7 ? (0xff000000 | (((tick * 13) % 256) << 16)) >>> 0 : 0xff1e140a,
    );
    frames.push({
      width: drawing.width,
      height: drawing.height,
      hash: runtime.runtime_hash() >>> 0,
      pixels,
    });
  }
  references[language] = frames;
  if (language === "luau") {
    for (let tick = 0; tick < frames.length; tick++) {
      assert.deepEqual(frames[tick], references.odin[tick], `SDK pixels tick ${tick}`);
    }
  }
  const capture = resolve(root, language + "-native");
  await mkdir(capture);
  const native = run(resolve(root, "trace.exe"), [wasm, source || "", capture])
    .stdout.trim()
    .split(/\r?\n/)
    .map(JSON.parse);
  for (const frame of native) {
    assert.equal(frame.hash, frames[frame.tick].hash);
    assert.deepEqual(
      await readFile(resolve(capture, frame.tick + ".rgba")),
      frames[frame.tick].pixels,
      `${language} native bytes ${frame.tick}`,
    );
  }
  const player = run(resolve(project, "build/native", nativePlayer), [
    "--game",
    wasm,
    ...(source ? ["--source", source] : []),
    "--replay",
    resolve(root, "replay.txt"),
  ])
    .stdout.trim()
    .split(/\r?\n/)
    .map(JSON.parse);
  assert.deepEqual(
    player.map((frame) => frame.hash),
    frames.slice(1).map((frame) => frame.hash),
    "standalone player uses typed presentation",
  );
  const fault = run(resolve(root, "trace.exe"), [wasm, source || "", capture, "fault"], 1);
  assert.match(fault.stderr, /feedback/i);
  const measured = run(resolve(root, "trace.exe"), [wasm, source || "", capture, "bench"])
    .stdout.trim()
    .split(/\r?\n/)
    .map(JSON.parse);
  benchmarks[language] = { native: measured };
}

await writeFile(
  resolve(root, "comparison.html"),
  "<!doctype html><meta charset=utf-8><title>Graphics conformance</title><style>body{background:#151821;color:#eee;font:16px sans-serif}section{display:inline-block;margin:12px}canvas{display:block;image-rendering:pixelated}</style><h1>Native / browser graphics conformance</h1><p>Both SDKs produce identical pixels. Captured 640&times;360 composition:</p>",
);
const server = serve(".", 0);
await once(server, "listening");
let browser;
try {
  browser = await chromium.launch({
    channel: process.env.PLAYER_BROWSER_CHANNEL || undefined,
  });
  const page = await browser.newPage({ viewport: { width: 1360, height: 500 } });
  await page.exposeFunction(
    "verifyGraphicsPixels",
    (language, tick, encoded, width, height, hash) => {
      const expected = references[language][tick];
      assert.equal(width, expected.width);
      assert.equal(height, expected.height);
      assert.equal(hash, expected.hash);
      assert.deepEqual(
        Buffer.from(encoded, "base64"),
        expected.pixels,
        `${language} browser bytes ${tick}`,
      );
    },
  );
  await page.goto(
    `http://127.0.0.1:${server.address().port}/${relative(process.cwd(), root).replaceAll("\\", "/")}/comparison.html`,
  );
  for (const language of ["odin", "luau"]) {
    const base =
      "/" + relative(process.cwd(), resolve(projects[language], "build/web")).replaceAll("\\", "/");
    const measured = await page.evaluate(
      async ({ base, language }) => {
        const worker = new Worker(base + "/worker.js", { type: "module" });
        const request = (message, expected) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Graphics worker deadline")), 120000);
            worker.onerror = (event) => {
              clearTimeout(timer);
              reject(new Error(event.message));
            };
            worker.onmessage = ({ data }) => {
              if (data.type === "error") {
                clearTimeout(timer);
                reject(new Error(data.error));
              } else if (data.type === expected) {
                clearTimeout(timer);
                resolve(data);
              }
            };
            worker.postMessage(message);
          });
        try {
          const load = {
            type: "load",
            gameUrl: location.origin + base + (language === "luau" ? "/game.luau" : "/game.wasm"),
          };
          let output = await request(load, "ready");
          for (let tick = 0; tick <= 12; tick++) {
            if (tick) {
              output = await request(
                {
                  type: "step",
                  steps: 1,
                  input: {
                    buttons: 0,
                    pointer: tick === 10,
                    x: tick === 10 ? 500 : 0,
                    y: 50,
                  },
                },
                "frame",
              );
            }
            const bytes = new Uint8Array(output.pixels),
              chunks = [];
            for (let at = 0; at < bytes.length; at += 32768) {
              chunks.push(String.fromCharCode(...bytes.subarray(at, at + 32768)));
            }
            await window.verifyGraphicsPixels(
              language,
              tick,
              btoa(chunks.join("")),
              output.width,
              output.height,
              output.hash,
            );
            if (tick === 12) {
              const section = document.createElement("section");
              section.textContent = language;
              const canvas = document.createElement("canvas");
              canvas.width = output.width;
              canvas.height = output.height;
              canvas
                .getContext("2d")
                .putImageData(
                  new ImageData(new Uint8ClampedArray(output.pixels), output.width, output.height),
                  0,
                  0,
                );
              section.append(canvas);
              document.body.append(section);
            }
          }
          await request(load, "ready");
          let rejected = false;
          try {
            await request(
              { type: "step", steps: 1, input: { buttons: 4, pointer: false, x: 0, y: 0 } },
              "frame",
            );
          } catch (error) {
            if (!/feedback/i.test(error.message)) {
              throw error;
            }
            rejected = true;
          }
          if (!rejected) {
            throw new Error("Feedback was accepted");
          }
          await request(load, "ready");
          const measured = await request(
            { type: "benchmark", masks: Array(120).fill(8) },
            "benchmark",
          );
          await request(load, "ready");
          const canvas = document.createElement("canvas");
          canvas.width = 640;
          canvas.height = 360;
          canvas.style.cssText = "position:fixed;top:0;left:0;z-index:10";
          document.body.append(canvas);
          const context = canvas.getContext("2d"),
            roundTrips = [],
            hashes = [];
          const pacedStart = performance.now();
          try {
            for (let tick = 1; tick <= 120; tick++) {
              await new Promise(requestAnimationFrame);
              const start = performance.now();
              const frame = await request(
                { type: "step", steps: 1, input: { buttons: 8, pointer: false, x: 0, y: 0 } },
                "frame",
              );
              context.putImageData(
                new ImageData(new Uint8ClampedArray(frame.pixels), 640, 360),
                0,
                0,
              );
              roundTrips.push(performance.now() - start);
              hashes.push(frame.hash);
            }
          } finally {
            canvas.remove();
          }
          measured.paced = {
            deliveredFps: 120000 / (performance.now() - pacedStart),
            roundTrips,
            hashes,
          };
          return measured;
        } finally {
          worker.terminate();
        }
      },
      { base, language },
    );
    benchmarks[language].browser = measured;
  }
  await page.screenshot({ path: resolve(root, "composition.png"), fullPage: true });
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
  };
}
const summary = {
  resolution: [640, 360],
  uploadBytesPerFrame: 640 * 360 * 4,
  logicalUploadBytesPerSecondAt60Hz: 640 * 360 * 4 * 60,
  languages: {},
};
for (const [language, result] of Object.entries(benchmarks)) {
  const native = result.native.slice(1),
    warm = native.slice(20),
    web = result.browser;
  summary.languages[language] = {
    native: {
      ...distribution(warm.map((frame) => frame.totalMs)),
      guestBytes: native.at(-1).guestBytes,
      resourceBytes: native.at(-1).resourceBytes,
      peakResourceBytes: native.at(-1).peakResourceBytes,
      pacedFps: 119000 / (native.at(-1).wallMs - native[0].wallMs),
      packetBytesPerFrame: (native.at(-1).packetBytes - native[19].packetBytes) / 100,
      hostCopyBytesPerFrame: (native.at(-1).hostCopyBytes - native[19].hostCopyBytes) / 100,
    },
    browser: {
      ...distribution(web.timings.map((row) => row[0] + row[1] + row[2])),
      pixelDelivery: distribution(web.timings.map((row) => row[3])),
      ...web.memory,
      ...web.resourceStats,
      packetBytesPerFrame: web.resourceStats.packetBytes / 120,
      hostCopyBytesPerFrame: web.resourceStats.hostCopyBytes / 120,
      pacedFps: web.paced.deliveredFps,
      pacedRoundTrip: distribution(web.paced.roundTrips),
    },
  };
  assert.deepEqual(
    web.traces.map((frame) => frame.hash),
    native.map((frame) => frame.hash),
    "full-frame upload benchmark parity",
  );
  assert.deepEqual(
    web.paced.hashes,
    native.map((frame) => frame.hash),
    "paced upload pixels match native",
  );
}
await writeFile(
  resolve(root, "report.json"),
  JSON.stringify({ summary, benchmarks }, null, 2) + "\n",
);
console.log(JSON.stringify(summary, null, 2));
console.log(
  "Graphics passed: both SDKs, native/browser bytes, readback versions, display switches, feedback rejection and 640x360 upload measurements.",
);
