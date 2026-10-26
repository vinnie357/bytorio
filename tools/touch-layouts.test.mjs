import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";
import {
  DEFAULT_LAYOUT,
  LAYOUTS,
  LAYOUT_STORAGE_KEY,
  chooseTouchLayout,
  crossDirection,
  discDirection,
  layoutFor,
} from "../runtime/odin/web/touch.js";
import { serve } from "./serve.mjs";
import { repo } from "./toolchain.mjs";
import { DOWN, LEFT, RIGHT, UP, phone, startPage } from "./touch-test-support.mjs";

const DIRECTIONS = [LEFT, RIGHT, UP, DOWN];
const MOVE_BITS = (n) => DIRECTIONS.filter((bits) => (n & bits) === bits).length;
// A phone shape per orientation, plus a small portrait one, all at 3x.
const VIEWPORTS = [
  { width: 844, height: 390 },
  { width: 390, height: 844 },
  { width: 360, height: 640 },
];

test("the registry holds the cross as the default and the disc, and falls back to the cross", () => {
  assert.deepEqual(Object.keys(LAYOUTS).sort(), ["cross", "disc"]);
  assert.equal(DEFAULT_LAYOUT, "cross");
  assert.equal(layoutFor("disc"), LAYOUTS.disc);
  assert.equal(layoutFor("cross"), LAYOUTS.cross);
  for (const unknown of ["", "nope", undefined, null, "__proto__", "constructor", 7]) {
    assert.equal(layoutFor(unknown), LAYOUTS.cross, String(unknown));
  }
  for (const layout of Object.values(LAYOUTS)) {
    assert.equal(typeof layout.label, "string");
    assert.equal(typeof layout.direction, "function");
  }
});

test("the cross is four-way: the dominant axis wins and a diagonal never appears", () => {
  assert.equal(crossDirection(-0.9, 0), LEFT);
  assert.equal(crossDirection(0.9, 0), RIGHT);
  assert.equal(crossDirection(0, -0.9), UP);
  assert.equal(crossDirection(0, 0.9), DOWN);
  // A corner touch resolves to the nearer arm: the axis with the larger travel.
  assert.equal(crossDirection(0.9, -0.5), RIGHT);
  assert.equal(crossDirection(0.5, -0.9), UP);
  assert.equal(crossDirection(-0.6, 0.9), DOWN);
  assert.equal(crossDirection(-0.9, 0.6), LEFT);
  // The hub is dead, including its edge, and a touch outside the square still resolves.
  assert.equal(crossDirection(0, 0), 0);
  assert.equal(crossDirection(0.1, -0.1), 0);
  assert.equal(crossDirection(1.4, 0.2), RIGHT);
  for (let x = -1; x <= 1; x += 0.05) {
    for (let y = -1; y <= 1; y += 0.05) {
      assert.ok(MOVE_BITS(crossDirection(x, y)) <= 1, `${x.toFixed(2)},${y.toFixed(2)}`);
    }
  }
});

test("the disc keeps its two-axis directions", () => {
  assert.equal(discDirection(-0.9, -0.9), (LEFT | UP) >>> 0);
  assert.equal(discDirection(0.9, 0.9), (RIGHT | DOWN) >>> 0);
  assert.equal(discDirection(0.1, 0.1), 0);
  assert.equal(discDirection(0.9, 0), RIGHT);
});

test("the choice is the query, then the stored layout, then the cross, and storage can fail", () => {
  const store = (value) => ({ getItem: () => value });
  const broken = {
    getItem() {
      throw new Error("storage is blocked");
    },
  };
  assert.equal(
    chooseTouchLayout({ search: "?touch-layout=disc", storage: store("cross") }),
    "disc",
  );
  assert.equal(
    chooseTouchLayout({ search: "?touch-layout=cross", storage: store("disc") }),
    "cross",
  );
  assert.equal(chooseTouchLayout({ search: "", storage: store("disc") }), "disc");
  assert.equal(chooseTouchLayout({ search: "?renderer=cpu", storage: store("disc") }), "disc");
  assert.equal(chooseTouchLayout({ search: "", storage: store(null) }), "cross");
  assert.equal(chooseTouchLayout({ search: "", storage: broken }), "cross");
  assert.equal(chooseTouchLayout({ search: "?touch-layout=disc", storage: broken }), "disc");
  assert.equal(chooseTouchLayout({ search: "", storage: undefined }), "cross");
  // An unknown value anywhere is the cross, not a guess at what was meant.
  assert.equal(
    chooseTouchLayout({ search: "?touch-layout=nope", storage: store("disc") }),
    "cross",
  );
  assert.equal(chooseTouchLayout({ search: "", storage: store("nope") }), "cross");
  assert.equal(LAYOUT_STORAGE_KEY, "bytorio-touch-layout");
});

async function launch() {
  return chromium.launch({
    channel: process.env.PLAYER_BROWSER_CHANNEL || undefined,
    headless: true,
  });
}

test("the cross sends one direction per arm, never a diagonal, and lights only the pressed arm", async () => {
  const { server, url } = await startPage("cross");
  const browser = await launch();
  try {
    for (const viewport of VIEWPORTS) {
      const label = `${viewport.width}x${viewport.height}`;
      const { context, page, send, at, mask } = await phone(browser, url, viewport, undefined, 3);
      const arm = (name) => page.locator(`[data-touch="dpad"] [data-arm="${name}"]`);
      assert.equal(await page.locator('[data-touch="dpad"]').getAttribute("data-layout"), "cross");
      for (const name of ["up", "down", "left", "right"]) {
        assert.ok(await arm(name).isVisible(), `${label}: the ${name} arm is drawn`);
        assert.ok((await arm(name).textContent()).trim(), `${label}: the ${name} arm has an arrow`);
      }
      const touches = [
        [0.1, 0.5, LEFT, "left"],
        [0.9, 0.5, RIGHT, "right"],
        [0.5, 0.1, UP, "up"],
        [0.5, 0.9, DOWN, "down"],
        // Corners resolve to the nearer arm, not to two directions.
        [0.97, 0.7, RIGHT, "right"],
        [0.7, 0.97, DOWN, "down"],
        [0.03, 0.3, LEFT, "left"],
        [0.3, 0.03, UP, "up"],
      ];
      for (const [fx, fy, bits, lit] of touches) {
        await send("touchStart", [await at("dpad", fx, fy)]);
        assert.equal(await mask(), bits, `${label} at ${fx},${fy}`);
        const pressed = await page
          .locator('[data-touch="dpad"] .pressed')
          .evaluateAll((all) => all.map((element) => element.dataset.arm));
        assert.deepEqual(pressed, [lit], `${label}: only the ${lit} arm is pressed`);
        await send("touchEnd", []);
        assert.equal(await mask(), 0);
        assert.equal(await page.locator('[data-touch="dpad"] .pressed').count(), 0);
      }
      await send("touchStart", [await at("dpad")]);
      assert.equal(await mask(), 0, `${label}: the hub is dead`);
      assert.equal(await page.locator('[data-touch="dpad"] .pressed').count(), 0);
      // Sliding from arm to arm without lifting changes the direction.
      await send("touchMove", [await at("dpad", 0.1, 0.5)]);
      assert.equal(await mask(), LEFT);
      await send("touchMove", [await at("dpad", 0.5, 0.1)]);
      assert.equal(await mask(), UP);
      await send("touchMove", [await at("dpad", 0.9, 0.9)]);
      assert.ok(MOVE_BITS(await mask()) === 1, "a corner in a slide is still one direction");
      await send("touchEnd", []);
      assert.equal(await mask(), 0);
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
});

test("the disc still lights as one piece and allows diagonals at each phone shape", async () => {
  const { server, url } = await startPage("disc");
  const browser = await launch();
  try {
    for (const viewport of VIEWPORTS) {
      const { context, page, send, at, mask } = await phone(browser, url, viewport, undefined, 3);
      assert.equal(await page.locator('[data-touch="dpad"]').getAttribute("data-layout"), "disc");
      assert.equal(await page.locator('[data-touch="dpad"] [data-arm]').count(), 0);
      await send("touchStart", [await at("dpad", 0.15, 0.15)]);
      assert.equal(await mask(), (LEFT | UP) >>> 0);
      assert.equal(await page.locator('[data-touch="dpad"].pressed').count(), 1);
      await send("touchEnd", []);
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
});

test("switching layouts applies live, keeps the page, and releases held pointers", async () => {
  const { server, url } = await startPage("cross");
  const browser = await launch();
  try {
    const { page, send, at, mask } = await phone(browser, url, VIEWPORTS[0], undefined, 3);
    await page.evaluate(() => {
      globalThis.sameDocument = "kept";
    });
    await send("touchStart", [await at("dpad", 0.1, 0.5), await at("a")]);
    assert.equal(await mask(), (LEFT | 16) >>> 0);
    const applied = await page.evaluate(() => globalThis.setTouchLayout("disc"));
    assert.equal(applied, "disc");
    assert.equal(await mask(), 0, "switching releases everything held");
    assert.equal(await page.locator('[data-touch="dpad"]').getAttribute("data-layout"), "disc");
    assert.equal(
      await page.evaluate(() => globalThis.sameDocument),
      "kept",
      "the page was not reloaded",
    );
    await send("touchEnd", []);
    await send("touchStart", [await at("dpad", 0.15, 0.15)]);
    assert.equal(await mask(), (LEFT | UP) >>> 0, "the new layout is live");
    await send("touchEnd", []);
    assert.equal(
      await page.evaluate(() => globalThis.setTouchLayout("nope")),
      "cross",
      "unknown means cross",
    );
    assert.equal(await page.locator('[data-touch="dpad"]').getAttribute("data-layout"), "cross");
  } finally {
    await browser.close();
    server.close();
  }
});

test("the settings form has the select outside the graphics fieldset and keeps the page markers", async () => {
  const html = await readFile(new URL("../runtime/odin/web/player.html", import.meta.url), "utf8");
  // ftl-myth's demo page customization matches these two markers and needs each exactly once.
  assert.equal(html.split("<label\n        >Frame rate").length, 2);
  assert.equal(html.split("</fieldset>").length, 2);
  const server = serve(repo, 0);
  await new Promise((accept) => server.once("listening", accept));
  const page = `http://127.0.0.1:${server.address().port}/runtime/odin/web/player.html`;
  const browser = await launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const desktop = await context.newPage();
    await desktop.goto(page);
    await desktop.waitForFunction(
      () => globalThis.document.getElementById("touch-layout")?.options.length,
    );
    const select = await desktop.evaluate(() => {
      const element = globalThis.document.getElementById("touch-layout");
      return {
        inFieldset: element.closest("fieldset") !== null,
        options: [...element.options].map((option) => option.value),
        value: element.value,
        label: element.closest("label")?.textContent.includes("Touch layout"),
      };
    });
    assert.deepEqual(select.options, Object.keys(LAYOUTS));
    assert.equal(select.value, "cross");
    assert.equal(select.inFieldset, false);
    assert.equal(select.label, true);
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
});

test("the select and the query parameter choose the layout, and storage failure means the cross", async () => {
  const server = serve(repo, 0);
  await new Promise((accept) => server.once("listening", accept));
  const base = `http://127.0.0.1:${server.address().port}/runtime/odin/web/player.html`;
  const browser = await launch();
  const dpad = (page) => page.locator('[data-touch="dpad"]').getAttribute("data-layout");
  try {
    const context = await browser.newContext({
      viewport: { width: 844, height: 390 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto(base);
    await page.waitForFunction(() => globalThis.document.getElementById("touch-controls"));
    assert.equal(await dpad(page), "cross");
    await page.selectOption("#touch-layout", "disc");
    assert.equal(await dpad(page), "disc", "the select applies live");
    await page.reload();
    await page.waitForFunction(() => globalThis.document.getElementById("touch-controls"));
    assert.equal(await dpad(page), "disc", "the choice is remembered");
    assert.equal(await page.locator("#touch-layout").inputValue(), "disc");
    await page.goto(`${base}?touch-layout=cross`);
    await page.waitForFunction(() => globalThis.document.getElementById("touch-controls"));
    assert.equal(await dpad(page), "cross", "the query parameter wins over what is stored");
    assert.equal(await page.locator("#touch-layout").inputValue(), "cross");
    await context.close();

    const blocked = await browser.newContext({
      viewport: { width: 844, height: 390 },
      isMobile: true,
      hasTouch: true,
    });
    await blocked.addInitScript(() => {
      for (const method of ["getItem", "setItem"]) {
        globalThis.Storage.prototype[method] = () => {
          throw new Error("storage is blocked");
        };
      }
    });
    const stuck = await blocked.newPage();
    const errors = [];
    stuck.on("pageerror", (error) => errors.push(error.message));
    await stuck.goto(base);
    await stuck.waitForFunction(() => globalThis.document.getElementById("touch-controls"));
    assert.equal(await dpad(stuck), "cross");
    await stuck.selectOption("#touch-layout", "disc");
    assert.equal(await dpad(stuck), "disc", "switching still works without storage");
    assert.deepEqual(errors, []);
    await blocked.close();
  } finally {
    await browser.close();
    server.close();
  }
});

test("each layout leaves the 44px targets, the columns and the canvas as they were", async () => {
  const server = serve(repo, 0);
  await new Promise((accept) => server.once("listening", accept));
  const base = `http://127.0.0.1:${server.address().port}/runtime/odin/web/player.html`;
  const browser = await launch();
  try {
    for (const layout of Object.keys(LAYOUTS)) {
      for (const viewport of VIEWPORTS) {
        const { context, page, box } = await phone(
          browser,
          `${base}?touch-layout=${layout}`,
          viewport,
          () => globalThis.document.getElementById("touch-controls"),
          3,
        );
        const canvas = await page.locator("#canvas").boundingBox();
        const pad = await box("dpad");
        const label = `${layout} ${viewport.width}x${viewport.height}`;
        assert.ok(pad.width >= 44 && pad.height >= 44, `${label} d-pad size`);
        assert.ok(pad.x >= 0 && pad.x + pad.width <= viewport.width, label);
        if (viewport.width > viewport.height) {
          assert.ok(
            pad.x + pad.width <= canvas.x || canvas.x + canvas.width <= pad.x,
            `${label}: the d-pad stays beside the canvas`,
          );
        } else {
          assert.ok(
            pad.y >= canvas.y + canvas.height - 1,
            `${label}: the d-pad stays below the canvas`,
          );
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
});
