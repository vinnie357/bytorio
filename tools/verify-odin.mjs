import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "./browser-timing.mjs";
import { serve } from "./serve.mjs";
import { tool, run, nativePlayer } from "./toolchain.mjs";

const root = "build/odin-player";
const executable = resolve(root, "native", nativePlayer);
function native(args, expected = 0) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 15000 });
  if (result.error) {
    throw result.error;
  }
  assert.equal(result.status, expected, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result;
}
await mkdir(`${root}/verification`, { recursive: true });
run(tool("odin"), ["test", "tests/timing", "-o:none", `-out:${root}/verification/timing.exe`]);
const report = JSON.parse(
  native(["--smoke", "--capture", `${root}/verification/native.bmp`]).stdout,
);
assert.equal(report.ticks, 120);
assert.equal(report.sounds, 2);
assert.equal(report.hash, 3747813061, "matches the 640×360 reference framebuffer");
assert.equal(report.audioQueuedFrames, 32000);
await writeFile(`${root}/verification/native.json`, JSON.stringify(report, null, 2) + "\n");
assert.deepEqual(
  await readFile(`${root}/native/game.wasm`),
  await readFile(`${root}/web/game.wasm`),
  "identical game binary on both hosts",
);
for (const [fixture, message] of [
  ["loop", /fuel/i],
  ["abi", /unsupported game ABI/i],
  ["offset", /frame offset/i],
  ["command", /invalid frame command/i],
  ["trap", /unreachable/i],
]) {
  assert.match(
    native(["--check", "--game", `${root}/web/fixtures/${fixture}.wasm`], 1).stderr,
    message,
  );
}

const server = serve(`${root}/web`, 0);
await once(server, "listening");
let browser;
let page;
const failures = [];
try {
  browser = await chromium.launch({ channel: process.env.PLAYER_BROWSER_CHANNEL || undefined });
  page = await browser.newPage();
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      failures.push(message.text());
    }
  });
  const url = `http://127.0.0.1:${server.address().port}/player.html`;
  await page.goto(url);
  await page.waitForFunction(
    () => globalThis.playerStatus?.ready || globalThis.playerStatus?.error,
  );
  assert.equal(await page.evaluate(() => globalThis.playerStatus.error), "");
  assert.equal(await page.title(), "Bytorio player");
  assert.equal(await page.evaluate(() => globalThis.crossOriginIsolated), false);
  await page.getByRole("button", { name: "Start game" }).click();
  await page.waitForFunction(
    () => globalThis.playerStatus.ticks > 3 && globalThis.playerAudio.played === 1,
  );
  const before = await page.evaluate(() => globalThis.playerStatus.x);
  await page.keyboard.down("ArrowRight");
  await page.waitForFunction((x) => globalThis.playerStatus.x > x + 8, before);
  await page.keyboard.up("ArrowRight");
  await page.keyboard.down("Space");
  await page.waitForFunction(() => globalThis.playerAudio.played === 2);
  const heldTick = await page.evaluate(() => globalThis.playerStatus.ticks);
  await page.waitForFunction((tick) => globalThis.playerStatus.ticks > tick + 5, heldTick);
  assert.equal(
    await page.evaluate(() => globalThis.playerAudio.played),
    2,
    "held action does not repeat sound",
  );
  await page.keyboard.up("Space");
  await page.waitForFunction((tick) => globalThis.playerStatus.ticks > tick + 8, heldTick);
  const canvas = page.locator("canvas");
  const bounds = await canvas.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 4, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.waitForFunction(
    () => Math.abs(globalThis.playerStatus.x - 152) < 0.01 && globalThis.playerAudio.played === 3,
  );
  const pointerTick = await page.evaluate(() => globalThis.playerStatus.ticks);
  await page.mouse.move(bounds.x - 20, bounds.y + bounds.height / 2);
  await page.waitForFunction((tick) => globalThis.playerStatus.ticks > tick + 3, pointerTick);
  assert.equal(
    await page.evaluate(() => globalThis.playerStatus.x),
    152,
    "captured pointer outside the screen is ignored",
  );
  await page.mouse.up();
  assert.equal(await page.evaluate(() => globalThis.playerStatus.y), 172);

  const audio = await page.evaluate(async () => {
    const audio = globalThis.playerAudio;
    audio.play();
    const begin = audio.context.currentTime;
    const until = performance.now() + 500;
    while (performance.now() < until) {
      /* Deliberate UI-thread stall. */
    }
    const advanced = audio.context.currentTime - begin;
    const offline = new OfflineAudioContext(1, 16000, 48000);
    const source = offline.createBufferSource();
    source.buffer = audio.buffer;
    source.connect(offline.destination);
    source.start();
    const output = await offline.startRendering();
    let peak = 0;
    for (const value of output.getChannelData(0)) {
      peak = Math.max(peak, Math.abs(value));
    }
    return { advanced, peak, state: audio.context.state };
  });
  assert.ok(audio.advanced > 0.25 && audio.peak > 0.1 && audio.peak < 1);
  assert.equal(audio.state, "running");
  await page.screenshot({ path: `${root}/verification/browser.png`, fullPage: true });

  await page.goto(`${url}?smoke`);
  await page.waitForFunction(() => globalThis.playerStatus?.ready);
  await page.getByRole("button", { name: "Start game" }).click();
  await page.waitForFunction(() => globalThis.playerStatus.ticks === 120);
  const smoke = await page.evaluate(() => globalThis.playerStatus);
  assert.equal(smoke.hash, report.hash);
  assert.equal(smoke.sounds, report.sounds);
  assert.equal(smoke.spriteX, report.spriteX);
  assert.equal(smoke.spriteY, report.spriteY);

  for (const fps of ["30", "144", "native", "uncapped"]) {
    const capped = JSON.parse(native(["--check", "--fps", fps]).stdout);
    assert.equal(capped.hash, report.hash, "render policy does not alter deterministic check mode");
    await page.goto(`${url}?smoke&fps=${fps}`);
    await page.waitForFunction(() => globalThis.playerStatus?.ready);
    await page.locator("#start").click();
    await page.waitForFunction(() => globalThis.playerStatus.ticks === 120);
    assert.equal(await page.evaluate(() => globalThis.playerStatus.hash), report.hash);
    assert.equal(await page.locator("#frame-rate").inputValue(), Number(fps) > 0 ? "capped" : fps);
    if (Number(fps) > 0) {
      assert.equal(await page.locator("#frame-rate-cap").inputValue(), fps);
    }
  }
  assert.match(native(["--check", "--fps", "0"], 1).stderr, /frame rate/i);
  await page.goto(`${url}?fps=0`);
  await page.waitForFunction(() => !!globalThis.playerStatus?.error);
  assert.match(await page.locator("#status").textContent(), /Frame rate/i);

  await page.goto(`${url}?fps=30`);
  await page.waitForFunction(() => globalThis.playerStatus?.ready);
  await page.locator("#start").click();
  await page.waitForFunction(() => globalThis.playerStatus.ticks >= 10);
  const pacingStart = await page.evaluate(() => ({
    ...globalThis.playerStatus,
    time: performance.now(),
  }));
  await page.waitForFunction(
    (tick) => globalThis.playerStatus.ticks >= tick + 60,
    pacingStart.ticks,
  );
  const pacingEnd = await page.evaluate(() => ({
    ...globalThis.playerStatus,
    time: performance.now(),
  }));
  const delivered = pacingEnd.frames - pacingStart.frames;
  const updates = pacingEnd.ticks - pacingStart.ticks;
  assert(updates >= 60 && updates <= 65);
  assert(delivered >= 24 && delivered <= 34, "30 FPS cap keeps the 60 Hz update rate");
  assert(
    pacingEnd.time - pacingStart.time >= 850,
    "simulation uses real time rather than render count",
  );
  await page.locator("#frame-rate").selectOption("native");
  await page.waitForFunction(() => globalThis.playerStatus.renderFps === "native");
  await page.locator("#frame-rate").selectOption("uncapped");
  await page.waitForFunction(() => globalThis.playerStatus.renderFps === "uncapped");
  assert.equal(await page.locator("#frame-rate-cap").isDisabled(), true);

  for (const [fixture, message] of [
    ["loop", /stopped responding/i],
    ["abi", /unsupported game ABI/i],
    ["offset", /frame offset/i],
    ["command", /invalid frame command/i],
    ["trap", /unreachable/i],
  ]) {
    await page.goto(`${url}?game=fixtures/${fixture}.wasm`);
    const start = performance.now();
    await page.waitForFunction(() => !!globalThis.playerStatus?.error, null, { timeout: 10000 });
    assert.match(await page.locator("#status").textContent(), message);
    assert.ok(performance.now() - start < 5000, "controlled failure recovers promptly");
    if (fixture === "loop") {
      // Restart the same UI with valid bytes after the watchdog terminates the runaway Worker.
      await page.route("**/fixtures/loop.wasm", async (route) =>
        route.fulfill({
          body: await readFile(`${root}/web/game.wasm`),
          contentType: "application/wasm",
        }),
      );
      await page.getByRole("button", { name: "Restart game" }).click();
      await page.waitForFunction(
        () => globalThis.playerStatus.ready && globalThis.playerStatus.ticks > 2,
      );
      assert.equal(await page.evaluate(() => globalThis.playerStatus.error), "");
      await page.unroute("**/fixtures/loop.wasm");
    }
  }
  assert.deepEqual(failures, []);
  const result = {
    native: report,
    browser: browser.version(),
    smoke,
    audio,
    errorFixturesPerHost: 5,
    sharedMemoryRequired: false,
  };
  await writeFile(`${root}/verification/report.json`, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(
    JSON.stringify({
      failures,
      status: await page?.evaluate(() => globalThis.playerStatus).catch(() => null),
    }),
  );
  throw error;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
