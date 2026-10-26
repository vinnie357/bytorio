import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import * as controls from "../runtime/odin/web/constants.js";
import { serve } from "./serve.mjs";
import { repo } from "./toolchain.mjs";

// The same bits gamepad.js sends, so every Bytorio game reads touch like a pad.
const LEFT = (1 | controls.BUTTON_MOVE_LEFT) >>> 0;
const RIGHT = (2 | controls.BUTTON_MOVE_RIGHT) >>> 0;
const UP = (4 | controls.BUTTON_MOVE_UP) >>> 0;
const DOWN = (8 | controls.BUTTON_MOVE_DOWN) >>> 0;
const PHONES = [
  { name: "landscape", viewport: { width: 844, height: 390 } },
  { name: "portrait", viewport: { width: 390, height: 844 } },
];
const CONTROLS = ["dpad", "a", "b", "start", "l", "r"];

async function startPage() {
  const directory = resolve(repo, "build/touch-browser", randomUUID());
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, "index.html"),
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0}#screen{position:relative;width:max-content;margin:0 auto}
canvas{display:block;width:min(640px,calc(100vw - 32px));aspect-ratio:16/9;background:#222}</style>
<div id="screen"><canvas id="canvas" width="640" height="360" tabindex="0"></canvas></div>
<script type="module">
import { installTouchControls, touchButtons } from "/runtime/odin/web/touch.js";
window.touchButtons = touchButtons;
window.canvasPointers = 0;
document.getElementById("canvas").addEventListener("pointerdown", () => window.canvasPointers++);
installTouchControls({ parent: document.getElementById("screen") });
window.ready = true;
</script>`,
  );
  const server = serve(repo, 0);
  await new Promise((accept) => server.once("listening", accept));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}/build/touch-browser/${directory.split(/[\\/]/).at(-1)}/index.html`,
  };
}
async function phone(browser, url, viewport) {
  const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => globalThis.ready);
  const cdp = await context.newCDPSession(page);
  const send = (type, points) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map(([x, y], id) => ({ x, y, id })),
    });
  async function box(name) {
    const rectangle = await page.locator(`[data-touch="${name}"]`).boundingBox();
    assert.ok(rectangle, `${name} is visible`);
    return rectangle;
  }
  async function at(name, fx = 0.5, fy = 0.5) {
    const { x, y, width, height } = await box(name);
    return [x + width * fx, y + height * fy];
  }
  const mask = () => page.evaluate(() => globalThis.touchButtons());
  return { context, page, send, box, at, mask };
}

test("each button sends the gamepad bits and releases on lift", async () => {
  const { server, url } = await startPage();
  const browser = await chromium.launch({
    channel: process.env.PLAYER_BROWSER_CHANNEL || undefined,
    headless: true,
  });
  try {
    for (const { viewport } of PHONES) {
      const { context, send, at, mask } = await phone(browser, url, viewport);
      const cases = [
        ["a", 16],
        ["b", controls.BUTTON_ESCAPE],
        ["start", controls.BUTTON_MAP],
        ["l", controls.BUTTON_ROTATE_LEFT],
        ["r", controls.BUTTON_ROTATE_RIGHT],
        ["dpad", LEFT, 0.1, 0.5],
        ["dpad", RIGHT, 0.9, 0.5],
        ["dpad", UP, 0.5, 0.1],
        ["dpad", DOWN, 0.5, 0.9],
        ["dpad", (LEFT | UP) >>> 0, 0.15, 0.15],
      ];
      assert.equal(await mask(), 0);
      for (const [name, bits, fx, fy] of cases) {
        const point = await at(name, fx, fy);
        await send("touchStart", [point]);
        assert.equal(await mask(), bits >>> 0, `${name} ${bits} at ${viewport.width}`);
        await send("touchEnd", []);
        assert.equal(await mask(), 0, `${name} releases`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
});

test("two touches combine, a slide changes direction and a cancel releases", async () => {
  const { server, url } = await startPage();
  const browser = await chromium.launch({
    channel: process.env.PLAYER_BROWSER_CHANNEL || undefined,
    headless: true,
  });
  try {
    const { send, at, mask } = await phone(browser, url, PHONES[0].viewport);
    const left = await at("dpad", 0.1, 0.5);
    const right = await at("dpad", 0.9, 0.5);
    const a = await at("a");
    await send("touchStart", [left, a]);
    assert.equal(await mask(), (LEFT | 16) >>> 0, "d-pad and A together");
    await send("touchMove", [right, a]);
    assert.equal(await mask(), (RIGHT | 16) >>> 0, "sliding across the d-pad changes direction");
    await send("touchEnd", [right]);
    assert.equal(await mask(), RIGHT, "lifting A leaves the d-pad held");
    await send("touchCancel", []);
    assert.equal(await mask(), 0, "a cancelled touch releases everything");
  } finally {
    await browser.close();
    server.close();
  }
});

test("blur and a hidden page release held buttons", async () => {
  const { server, url } = await startPage();
  const browser = await chromium.launch({
    channel: process.env.PLAYER_BROWSER_CHANNEL || undefined,
    headless: true,
  });
  try {
    const { page, send, at, mask } = await phone(browser, url, PHONES[0].viewport);
    await send("touchStart", [await at("a")]);
    assert.equal(await mask(), 16);
    await page.evaluate(() => globalThis.dispatchEvent(new Event("blur")));
    assert.equal(await mask(), 0, "blur releases");
    await send("touchEnd", []);
    await send("touchStart", [await at("b")]);
    await page.evaluate(() => {
      Object.defineProperty(globalThis.document, "hidden", { configurable: true, value: true });
      globalThis.document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.equal(await mask(), 0, "hiding the page releases");
  } finally {
    await browser.close();
    server.close();
  }
});

test("controls are at least 44px, never cover the canvas middle and keep touches off the canvas", async () => {
  const { server, url } = await startPage();
  const browser = await chromium.launch({
    channel: process.env.PLAYER_BROWSER_CHANNEL || undefined,
    headless: true,
  });
  try {
    for (const { name, viewport } of PHONES) {
      const { context, page, send, box, at } = await phone(browser, url, viewport);
      const canvas = await page.locator("#canvas").boundingBox();
      const middle = {
        left: canvas.x + canvas.width * 0.25,
        right: canvas.x + canvas.width * 0.75,
        top: canvas.y + canvas.height * 0.2,
        bottom: canvas.y + canvas.height * 0.8,
      };
      for (const control of CONTROLS) {
        const rectangle = await box(control);
        assert.ok(rectangle.width >= 44 && rectangle.height >= 44, `${name} ${control} size`);
        assert.ok(rectangle.x >= 0 && rectangle.x + rectangle.width <= viewport.width, control);
        const overlapsMiddle =
          rectangle.x < middle.right &&
          rectangle.x + rectangle.width > middle.left &&
          rectangle.y < middle.bottom &&
          rectangle.y + rectangle.height > middle.top;
        assert.equal(overlapsMiddle, false, `${name} ${control} leaves the canvas middle clear`);
        if (name === "portrait") {
          assert.ok(
            rectangle.y >= canvas.y + canvas.height - 1,
            `${control} sits below the canvas`,
          );
        }
      }
      await send("touchStart", [await at("a")]);
      await send("touchEnd", []);
      assert.equal(await page.evaluate(() => globalThis.canvasPointers), 0);
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
});

test("a desktop shows no overlay until the first touch", async () => {
  const { server, url } = await startPage();
  const browser = await chromium.launch({
    channel: process.env.PLAYER_BROWSER_CHANNEL || undefined,
    headless: true,
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => globalThis.ready);
    assert.equal(await page.locator("#touch-controls").count(), 0, "nothing is built for a mouse");
    assert.equal(await page.evaluate(() => globalThis.touchButtons()), 0);
    await page.evaluate(() =>
      globalThis.dispatchEvent(
        new globalThis.PointerEvent("pointerdown", { pointerType: "touch" }),
      ),
    );
    assert.equal(
      await page.locator("#touch-controls").isVisible(),
      true,
      "the first touch shows it",
    );
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
});
