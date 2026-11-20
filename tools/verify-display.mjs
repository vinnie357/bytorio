import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { once } from "node:events";
import { chromium } from "./browser-timing.mjs";
import { serve } from "./serve.mjs";
import { tool, nativePlayer } from "./toolchain.mjs";
import {
  submitDrawing,
  rasterizeDrawing,
  loadSource,
  checkExecutor,
} from "../runtime/odin/web/policy.js";
const root = "examples/rpg/build/odin",
  web = `${root}/web`;
await mkdir(`${web}/display`, { recursive: true });
for (const invalid of [false, true]) {
  const result = spawnSync(
    tool("odin"),
    [
      "build",
      "tests/odin/display",
      "-target:freestanding_wasm32",
      "-no-entry-point",
      "-o:speed",
      `-define:DISPLAY_INVALID=${invalid}`,
      `-out:${web}/display/${invalid ? "invalid" : "switch"}.wasm`,
      "-extra-linker-flags:--max-memory=8388608",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
}
const runtimeBytes = await readFile(`${web}/runtime.wasm`);
const expected = [];
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
const game = (await WebAssembly.instantiate(await readFile(`${web}/display/switch.wasm`), imports))
  .instance.exports;
const runtime = (await WebAssembly.instantiate(runtimeBytes, imports)).instance.exports;
runtime.runtime_init();
game.game_init();
for (let i = 0; i < 120; i++) {
  game.game_update(0, 0, 0, 0);
  const drawing = submitDrawing(game, runtime);
  rasterizeDrawing(runtime, drawing);
  assert.equal(drawing.width, i >= 29 && i < 89 ? 320 : 640);
  expected.push({ hash: runtime.runtime_hash() >>> 0, sounds: 0 });
}
await writeFile(`${root}/display.inputs`, Array(120).fill(0).join("\n") + "\n");
function native(path) {
  return spawnSync(
    resolve(`${root}/native/${nativePlayer}`),
    ["--game", path, "--replay", `${root}/display.inputs`],
    { encoding: "utf8", timeout: 30000 },
  );
}
const report = native(`${web}/display/switch.wasm`);
assert.equal(report.status, 0, report.stderr);
assert.deepEqual(report.stdout.trim().split(/\r?\n/).map(JSON.parse), expected);
const bad = native(`${web}/display/invalid.wasm`);
assert.notEqual(bad.status, 0);
assert.match(bad.stderr, /unsupported display mode/);
const presented = spawnSync(
  resolve(`${root}/native/${nativePlayer}`),
  ["--game", `${web}/display/switch.wasm`, "--smoke"],
  {
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      SDL_VIDEODRIVER: "dummy",
      SDL_AUDIODRIVER: "dummy",
      SDL_RENDER_DRIVER: "software",
    },
  },
);
assert.equal(presented.status, 0, presented.stderr);
assert.equal(
  JSON.parse(presented.stdout).hash,
  expected.at(-1).hash,
  "SDL recreates textures across switches",
);
// The source executor exposes the same mode request, reset and validation rules.
const executor = (
  await WebAssembly.instantiate(await readFile("build/luau-executor/luau-executor.wasm"), imports)
).instance.exports;
executor._initialize();
loadSource(
  executor,
  Buffer.from(
    "return {init=function() console.display(320,180) end, update=function() console.display(640,360) end, draw=function() end}",
  ),
);
executor.game_init();
checkExecutor(executor);
assert.equal(executor.game_display_mode(), (320 << 16) | 180);
executor.game_update(0, 0, 0, 0);
checkExecutor(executor);
assert.equal(executor.game_display_mode(), (640 << 16) | 360);
loadSource(executor, Buffer.from("return {init=function() console.display(384,216) end}"));
executor.game_init();
assert.throws(() => checkExecutor(executor), /unsupported display mode/);
loadSource(executor, Buffer.from("return {init=function() console.display(320.5,180) end}"));
executor.game_init();
assert.throws(() => checkExecutor(executor), /unsupported display mode/);
const server = serve(web, 0);
await once(server, "listening");
const browser = await chromium.launch({
  channel: process.env.PLAYER_BROWSER_CHANNEL || "chrome",
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(
    `http://127.0.0.1:${server.address().port}/debug.html?game=./display/switch.wasm`,
  );
  await page.waitForFunction(() => playerStatus.ready || playerStatus.error);
  assert.equal(await page.evaluate(() => playerStatus.error), "");
  assert.deepEqual(await page.locator("canvas").evaluate((c) => [c.width, c.height]), [640, 360]);
  await page.locator("#fullscreen").click();
  await page.waitForFunction(() => document.fullscreenElement?.id === "screen");
  // Fullscreen state can become visible before fullscreenchange applies the
  // integer-scaled canvas dimensions. Wait for that observable result too.
  await page.waitForFunction(() => {
    const bounds = document.querySelector("canvas").getBoundingClientRect();
    return bounds.width === 1280 && bounds.height === 720;
  });
  const bounds = await page.locator("canvas").boundingBox();
  assert.equal(bounds.width, 1280);
  assert.equal(bounds.height, 720);
  await page.evaluate(() => document.exitFullscreen());
  await page.locator("#start").click();
  await page.waitForFunction(() => playerStatus.ticks >= 35 && playerStatus.ticks < 85);
  assert.deepEqual(await page.locator("canvas").evaluate((c) => [c.width, c.height]), [320, 180]);
  await page.waitForFunction(() => playerStatus.ticks >= 95);
  assert.deepEqual(await page.locator("canvas").evaluate((c) => [c.width, c.height]), [640, 360]);
  const traces = await page.evaluate(async () => {
    const worker = new Worker("./worker.js", { type: "module" });
    const next = () =>
      new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => {
          if (data.type === "error") {
            reject(new Error(data.error));
          } else if (data.type !== "executing") {
            resolve(data);
          }
        };
        worker.onerror = reject;
      });
    let pending = next();
    worker.postMessage({ type: "load", gameUrl: "./display/switch.wasm" });
    await pending;
    const frames = [];
    for (let i = 0; i < 120; i++) {
      pending = next();
      worker.postMessage({
        type: "step",
        steps: 1,
        input: { buttons: 0, pointer: false, x: 0, y: 0 },
      });
      const frame = await pending;
      if (frame.pixels.byteLength !== frame.width * frame.height * 4) {
        throw new Error("Invalid transfer size");
      }
      frames.push({ hash: frame.hash, sounds: frame.sounds });
    }
    worker.terminate();
    return frames;
  });
  assert.deepEqual(traces, expected);
  await page.goto(
    `http://127.0.0.1:${server.address().port}/debug.html?game=./display/invalid.wasm`,
  );
  await page.waitForFunction(() => playerStatus.error);
  assert.match(await page.evaluate(() => playerStatus.error), /Unsupported display mode/);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
console.log(
  "Display modes: native/browser 120-frame switch parity, bounded transfers, invalid modes and Luau requests passed.",
);
