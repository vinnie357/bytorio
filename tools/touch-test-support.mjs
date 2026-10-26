import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import * as controls from "../runtime/odin/web/constants.js";
import { serve } from "./serve.mjs";
import { repo } from "./toolchain.mjs";

// The same bits gamepad.js sends, so every Bytorio game reads touch like a pad.
export const LEFT = (1 | controls.BUTTON_MOVE_LEFT) >>> 0;
export const RIGHT = (2 | controls.BUTTON_MOVE_RIGHT) >>> 0;
export const UP = (4 | controls.BUTTON_MOVE_UP) >>> 0;
export const DOWN = (8 | controls.BUTTON_MOVE_DOWN) >>> 0;
export const PHONES = [
  { name: "landscape", viewport: { width: 844, height: 390 } },
  { name: "portrait", viewport: { width: 390, height: 844 } },
];
export const CONTROLS = ["dpad", "a", "b", "start", "l", "r"];
// Landscape also has a fullscreen button, because the page's own buttons fall below a phone's screen.
export const LANDSCAPE_CONTROLS = [...CONTROLS, "full"];

export async function startPage(layout = "disc") {
  const directory = resolve(repo, "build/touch-browser", randomUUID());
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, "index.html"),
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0}#screen{position:relative;width:max-content;margin:0 auto}
canvas{display:block;width:min(640px,calc(100vw - 32px));aspect-ratio:16/9;background:#222}</style>
<div id="screen"><canvas id="canvas" width="640" height="360" tabindex="0"></canvas></div>
<script type="module">
import { installTouchControls, setTouchLayout, touchButtons } from "/runtime/odin/web/touch.js";
window.touchButtons = touchButtons;
window.setTouchLayout = setTouchLayout;
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
    url: `http://127.0.0.1:${server.address().port}/build/touch-browser/${directory.split(/[\\/]/).at(-1)}/index.html?touch-layout=${layout}`,
  };
}
export async function phone(
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
