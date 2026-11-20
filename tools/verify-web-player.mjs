import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createProject, buildProject } from "./sdk/project.mjs";
import { chromium } from "./browser-timing.mjs";
import { serve } from "./serve.mjs";
import { bindPlayer } from "./browser-player.mjs";

const root = resolve("build/web-player-verification", randomUUID());
await mkdir(root, { recursive: true });
await createProject(root + "/game", "luau");
const entry = resolve(root, "game/src/main.luau");
await writeFile(
  entry,
  (await readFile(entry, "utf8")).replace(
    "local function draw()",
    "local function draw()\n    byt.debug_position(x, y)",
  ),
);
await buildProject(root + "/game");
await createProject(root + "/text", "luau");
await copyFile("tests/text-input/game.luau", resolve(root, "text/src/main.luau"));
await buildProject(root + "/text");
await writeFile(
  resolve(root, "index.html"),
  `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Embedded player test</title><link rel="icon" href="data:,"><style>body{margin:0} #game{max-width:720px;margin:auto} #outside{color:rgb(255,0,0)}</style>
<button id="outside">Host button</button><div id="game"></div>
<script type="module">
import {mountPlayer} from './game/build/web/web-player.js';
window.player=mountPlayer(document.querySelector('#game'),{cartridge:'./game/build/game.png',controls:{visibility:'always',overrides:{action:{label:'Jump'}}}});
window.game=player.runtime;
</script></html>`,
);
const server = serve(root, 0);
await once(server, "listening");
const browser = await chromium.launch({
  channel: process.env.PLAYER_BROWSER_CHANNEL || "chrome",
  headless: true,
});
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.waitForFunction(() => !!window.player);
  await page.evaluate(() => window.player.ready);
  assert.equal(await page.evaluate(() => "playerStatus" in window), false);
  assert.equal(
    await page.locator("#outside").evaluate((element) => getComputedStyle(element).color),
    "rgb(255, 0, 0)",
  );
  assert.equal(await page.locator(".diagnostics").isVisible(), false);
  await page.getByRole("button", { name: "Play game", exact: true }).click();
  await page.waitForFunction(() => window.game.getSnapshot().ticks > 5);
  const x = await page.evaluate(() => window.game.getSnapshot().x);
  const session = await context.newCDPSession(page);
  const right = await page.getByRole("button", { name: "Right", exact: true }).boundingBox();
  const action = await page.getByRole("button", { name: "Jump", exact: true }).boundingBox();
  const point = (bounds, id) => ({
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
    id,
  });
  const direction = point(right, 1),
    jump = point(action, 2);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [direction, jump],
  });
  await page.waitForFunction((before) => window.game.getSnapshot().x > before + 8, x);
  assert.equal(await page.locator(".pressed").count(), 2);
  assert.equal(await page.evaluate(() => window.game.getSnapshot().audio.played), 2);
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [jump] });
  assert.equal(await page.locator(".pressed").count(), 1);
  const hold = await page.evaluate(() => window.game.getSnapshot().x);
  await page
    .waitForFunction((before) => window.game.getSnapshot().x > before + 8, hold, { timeout: 5000 })
    .catch(async (error) => {
      console.error(
        JSON.stringify(
          await page.evaluate(() => ({
            state: window.game.getSnapshot(),
            pressed: [
              ...document
                .querySelector("#game")
                .firstElementChild.shadowRoot.querySelectorAll(".pressed"),
            ].map((element) => element.dataset.control),
          })),
        ),
      );
      throw error;
    });
  await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  assert.equal(await page.locator(".pressed").count(), 0);
  // Two contacts on the same digital button must remain held until both release.
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [direction, { ...direction, id: 3, x: direction.x + 5 }],
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [{ ...direction, id: 3, x: direction.x + 5 }],
  });
  assert.equal(
    await page.getByRole("button", { name: "Right", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  await page.getByRole("button", { name: "Mute", exact: true }).click();
  assert.equal(await page.evaluate(() => window.game.getSnapshot().audio.muted), true);
  await page.getByRole("button", { name: "Pause game", exact: true }).click();
  assert.equal(await page.evaluate(() => window.game.state), "paused");
  await page.getByRole("button", { name: "Play game", exact: true }).click();
  const canvas = page.locator("canvas");
  const bounds = await canvas.boundingBox();
  const pointer = { x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.5, id: 4 };
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pointer] });
  await page.waitForFunction(() => Math.abs(window.game.getSnapshot().x - 312) < 2);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ ...pointer, x: bounds.x + bounds.width * 0.25 }],
  });
  await page.waitForFunction(() => Math.abs(window.game.getSnapshot().x - 152) < 2);
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.screenshot({ path: resolve(root, "mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 844, height: 390 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  assert.equal(await page.getByRole("button", { name: "Right", exact: true }).isVisible(), true);
  await page.evaluate(() => document.exitFullscreen());
  await canvas.focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await page
      .getByRole("button", { name: "Up", exact: true })
      .evaluate((element) => element.getRootNode().activeElement === element),
    true,
    "Tab leaves the canvas for accessible navigation",
  );
  const sounds = await page.evaluate(() => window.game.getSnapshot().audio.played);
  await page.getByRole("button", { name: "Jump", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction((before) => window.game.getSnapshot().audio.played > before, sounds);
  await page.evaluate(() => window.player.load("./text/build/game.png"));
  await page.getByRole("button", { name: "Play game", exact: true }).click();
  const field = page.locator("input[data-bytorio-text]");
  await field.waitFor({ state: "visible" });
  await field.focus();
  await field.fill("Aé🙂");
  await page.waitForFunction(
    () => window.game.getSnapshot().x === 7 && window.game.getSnapshot().y === 2,
  );
  await field.press("Enter");
  await page.waitForFunction(() => window.game.getSnapshot().y === 6);
  await page.evaluate(() => window.player.dispose());
  assert.equal(await page.locator("canvas").count(), 0);
  const unwanted = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/must-not-fetch.png")) {
      unwanted.push(request.url());
    }
  });
  await page.goto(
    `http://127.0.0.1:${server.address().port}/game/build/web/player.html?local&game=must-not-fetch.png`,
  );
  await bindPlayer(page);
  assert.equal(await page.evaluate(() => window.hostedPlayer.runtime.state), "idle");
  assert.deepEqual(unwanted, []);
  await page.locator('input[type="file"]').setInputFiles(resolve(root, "game/build/game.png"));
  await page.waitForFunction(() => window.hostedPlayer.runtime.getSnapshot().ready);
  await page.getByRole("button", { name: "Play game", exact: true }).click();
  await page.waitForFunction(() => window.hostedPlayer.runtime.getSnapshot().ticks > 5);
  await page.evaluate(() => window.hostedPlayer.dispose());
  assert.deepEqual(errors, []);
  await context.close();
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
console.log(
  `Production player passed: scoped UI, public runtime, touch chords and same-button ownership, cancellation, pointer drag, mute/pause, orientation/fullscreen and disposal. Evidence: ${root}`,
);
