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
// Landscape also has a fullscreen button, because the page's own buttons fall below a phone's screen.
const LANDSCAPE_CONTROLS = [...CONTROLS, "full"];

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
window.activations = 0;
window.fullscreens = 0;
installTouchControls({
  parent: document.getElementById("screen"),
  onActivate: () => window.activations++,
  onFullscreen: () => window.fullscreens++,
});
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
async function phone(
  browser,
  url,
  viewport,
  ready = () => globalThis.ready,
  deviceScaleFactor = 1,
) {
  const context = await browser.newContext({
    viewport,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor,
  });
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(ready);
  const cdp = await context.newCDPSession(page);
  const send = (type, points) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map(([x, y, id], index) => ({ x, y, id: id ?? index })),
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
    await send("touchEnd", [[...a, 1]]);
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

// The real player page, which fits its canvas around the controls. It cannot load a runtime from the
// repository root, which is fine: the layout runs first.
const LAYOUTS = [
  { name: "landscape", viewport: { width: 844, height: 390 } },
  { name: "landscape", viewport: { width: 740, height: 360 } },
  { name: "landscape", viewport: { width: 932, height: 430 } },
  { name: "portrait", viewport: { width: 390, height: 844 } },
  { name: "portrait", viewport: { width: 360, height: 640 } },
];

test("controls are at least 44px, apart from each other and from the canvas, and keep touches off it", async () => {
  const server = serve(repo, 0);
  await new Promise((accept) => server.once("listening", accept));
  const url = `http://127.0.0.1:${server.address().port}/runtime/odin/web/player.html`;
  const browser = await chromium.launch({
    channel: process.env.PLAYER_BROWSER_CHANNEL || undefined,
    headless: true,
  });
  try {
    for (const { name, viewport } of LAYOUTS) {
      const label = `${name} ${viewport.width}x${viewport.height}`;
      const { context, page, send, box, at } = await phone(browser, url, viewport, () =>
        globalThis.document.getElementById("touch-controls"),
      );
      const canvas = await page.locator("#canvas").boundingBox();
      const boxes = [];
      for (const control of name === "landscape" ? LANDSCAPE_CONTROLS : CONTROLS) {
        const rectangle = await box(control);
        boxes.push([control, rectangle]);
        assert.ok(rectangle.width >= 44 && rectangle.height >= 44, `${label} ${control} size`);
        assert.ok(rectangle.x >= 0 && rectangle.x + rectangle.width <= viewport.width, label);
        const apart =
          rectangle.x + rectangle.width <= canvas.x ||
          canvas.x + canvas.width <= rectangle.x ||
          rectangle.y + rectangle.height <= canvas.y ||
          canvas.y + canvas.height <= rectangle.y;
        assert.ok(apart, `${label} ${control} covers the canvas`);
        if (name === "portrait") {
          assert.ok(
            rectangle.y >= canvas.y + canvas.height - 1,
            `${control} sits below the canvas`,
          );
        }
      }
      assert.ok(canvas.x >= 0 && canvas.x + canvas.width <= viewport.width, `${label} canvas fits`);
      for (const [first, one] of boxes) {
        for (const [second, two] of boxes) {
          const apart =
            first >= second ||
            one.x + one.width <= two.x ||
            two.x + two.width <= one.x ||
            one.y + one.height <= two.y ||
            two.y + two.height <= one.y;
          assert.ok(apart, `${label}: ${first} and ${second} overlap`);
        }
      }
      await page.evaluate(() => {
        globalThis.canvasPointers = 0;
        globalThis.document
          .getElementById("canvas")
          .addEventListener("pointerdown", () => globalThis.canvasPointers++);
      });
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

test("the player page fits a portrait phone instead of widening the layout", async () => {
  const server = serve(repo, 0);
  await new Promise((accept) => server.once("listening", accept));
  const browser = await chromium.launch({
    channel: process.env.PLAYER_BROWSER_CHANNEL || undefined,
    headless: true,
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    // The player cannot load a runtime from here, which is fine: the layout runs first.
    await page.goto(`http://127.0.0.1:${server.address().port}/runtime/odin/web/player.html`);
    await page.waitForFunction(() => globalThis.document.getElementById("touch-controls"));
    const layout = await page.evaluate(() => ({
      width: globalThis.innerWidth,
      canvas: globalThis.document.getElementById("canvas").getBoundingClientRect().right,
    }));
    assert.equal(layout.width, 390, "the canvas's own size must not widen the layout viewport");
    assert.ok(layout.canvas <= 390, `the canvas ends at ${layout.canvas}`);
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
});

test("lifting a touch on a control activates the host, and the fullscreen button asks for fullscreen", async () => {
  const { server, url } = await startPage();
  const browser = await chromium.launch({
    channel: process.env.PLAYER_BROWSER_CHANNEL || undefined,
    headless: true,
  });
  try {
    const { send, at, page } = await phone(browser, url, PHONES[0].viewport);
    const count = (name) => page.evaluate((key) => globalThis[key], name);
    await send("touchStart", [await at("a")]);
    assert.equal(await count("activations"), 0, "a press alone is not a user gesture to start on");
    await send("touchEnd", []);
    assert.equal(await count("activations"), 1, "lifting is");
    await send("touchStart", [await at("dpad", 0.9, 0.5)]);
    await send("touchEnd", []);
    assert.equal(await count("activations"), 2);
    await send("touchStart", [await at("full")]);
    await send("touchEnd", []);
    assert.equal(await count("fullscreens"), 1);
    assert.equal(
      await page.evaluate(() => globalThis.touchButtons()),
      0,
      "FULL sends no game bits",
    );
    const portrait = await phone(browser, url, PHONES[1].viewport);
    assert.equal(await portrait.page.locator('[data-touch="full"]').isVisible(), false);
  } finally {
    await browser.close();
    server.close();
  }
});

test("on 2x and 3x phones the canvas fills the room the controls leave, not half of it", async () => {
  const server = serve(repo, 0);
  await new Promise((accept) => server.once("listening", accept));
  const url = `http://127.0.0.1:${server.address().port}/runtime/odin/web/player.html`;
  const browser = await chromium.launch({
    channel: process.env.PLAYER_BROWSER_CHANNEL || undefined,
    headless: true,
  });
  try {
    const sizes = [
      { width: 844, height: 390 },
      { width: 740, height: 360 },
      { width: 932, height: 430 },
      { width: 390, height: 844 },
      { width: 360, height: 640 },
    ];
    for (const viewport of sizes) {
      for (const density of [2, 3]) {
        const label = `${viewport.width}x${viewport.height} at ${density}x`;
        const { context, page } = await phone(
          browser,
          url,
          viewport,
          () => globalThis.document.getElementById("touch-controls"),
          density,
        );
        const { canvas, column } = await page.evaluate(() => ({
          canvas: globalThis.document.getElementById("canvas").getBoundingClientRect().toJSON(),
          column: parseFloat(
            globalThis
              .getComputedStyle(globalThis.document.getElementById("touch-controls"))
              .getPropertyValue("--col"),
          ),
        }));
        const landscape = viewport.width > viewport.height;
        // The room left after the columns (landscape) or after the page's margin (portrait), and
        // after the control panel below the canvas in portrait.
        const roomWidth = landscape ? viewport.width - 2 * column : viewport.width - 32;
        const roomHeight = landscape ? viewport.height - 16 : Infinity;
        const fill = Math.max(canvas.width / roomWidth, canvas.height / roomHeight);
        assert.ok(
          fill >= 0.85,
          `${label}: the canvas fills ${Math.round(fill * 100)}% of its room`,
        );
        assert.ok(
          canvas.width <= roomWidth + 1 && canvas.height <= roomHeight + 1,
          `${label} fits`,
        );
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
});

test("a desktop keeps whole device pixels for the canvas", async () => {
  const server = serve(repo, 0);
  await new Promise((accept) => server.once("listening", accept));
  const browser = await chromium.launch({
    channel: process.env.PLAYER_BROWSER_CHANNEL || undefined,
    headless: true,
  });
  try {
    // 1280x720 leaves room for 1.58x; a whole scale is 1x, and the touch rule must not change that.
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/runtime/odin/web/player.html`);
    await page.waitForFunction(() => globalThis.document.getElementById("canvas").style.width);
    const canvas = await page.locator("#canvas").boundingBox();
    assert.equal(canvas.width, 640);
    assert.equal(canvas.height, 360);
    assert.equal(await page.locator("#touch-controls").count(), 0);
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
});
