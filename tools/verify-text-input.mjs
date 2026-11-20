import assert from "node:assert/strict";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { timedSpawnSync as spawnSync } from "./command-timing.mjs";
import { tool, dependencyRoot, nativeLinkerFlags, nativePlayer } from "./toolchain.mjs";
import { odinUnitTests } from "./odin-unit-tests.mjs";
import { createProject, buildProject, requireNativePlayer } from "./sdk/project.mjs";
import { chromium } from "./browser-timing.mjs";
import { serve } from "./serve.mjs";
requireNativePlayer();

const root = resolve("build/text-input-verification", randomUUID());
await mkdir(root, { recursive: true });
console.log(odinUnitTests("tests/sdk/input", resolve(root, "input-tests.exe")));
const nativeTest = resolve("build/odin-player/native/text-input-tests.exe");
const unit = spawnSync(
  tool("odin"),
  [
    "test",
    "runtime/odin/native",
    "-o:none",
    `-collection:deps=${dependencyRoot()}`,
    `-out:${nativeTest}`,
    ...nativeLinkerFlags({ harness: true }),
  ],
  {
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" },
  },
);
await writeFile(resolve(root, "native-events.log"), (unit.stdout || "") + (unit.stderr || ""));
assert.ifError(unit.error);
assert.equal(unit.status, 0, unit.stdout + unit.stderr);

for (const language of ["odin", "luau"]) {
  const project = resolve(root, language);
  await createProject(project, language);
  await copyFile(`tests/text-input/game.${language}`, resolve(project, `src/main.${language}`));
  await buildProject(project);
  const replay = resolve(project, "inputs.txt");
  await writeFile(replay, "0\n0\n16\n0\n1\n0\n");
  const result = spawnSync(
    resolve(project, "build/native", nativePlayer),
    [resolve(project, "build/game.png"), "--replay", replay],
    { encoding: "utf8", timeout: 30000 },
  );
  await writeFile(
    resolve(root, `${language}-native.log`),
    (result.stdout || "") + (result.stderr || ""),
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const frames = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(
    frames.map((frame) => frame.sounds),
    [1, 2, 2, 2, 3, 4],
  );
}

const server = serve(root, 0);
await once(server, "listening");
const browser = await chromium.launch({
  channel: process.env.PLAYER_BROWSER_CHANNEL || "chrome",
  headless: true,
});
try {
  for (const language of ["odin", "luau"]) {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/${language}/build/web/debug.html`);
    await page.waitForFunction(() => playerStatus.ready || playerStatus.error);
    assert.equal(await page.evaluate(() => playerStatus.error), "");
    await page.locator("#start").click();
    const field = page.locator("input[data-bytorio-text]");
    await field.waitFor({ state: "visible" });
    await field.fill("Aé🙂");
    await page.waitForFunction(() => playerStatus.x === 7 && playerStatus.y === 2);
    await field.press("Backspace");
    await page.waitForFunction(() => playerStatus.x === 3);
    await field.press("Enter");
    await page.waitForFunction(() => playerStatus.y === 6);
    const after = await page.evaluate(() => ({
      x: playerStatus.x,
      y: playerStatus.y,
      error: playerStatus.error,
    }));
    assert.deepEqual(after, { x: 3, y: 6, error: "" });
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
console.log(
  `Text input conformance passed: both SDKs, native SDL events and browser DOM editing. Evidence: ${root}`,
);
