import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createTextInputSession } from "../runtime/odin/web/text-session.js";
import { serve } from "./serve.mjs";
import { repo } from "./toolchain.mjs";
import { nativeTestArgs } from "./native-test-args.mjs";

const encoder = new TextEncoder();
function packet(value = "", { id = 7, maximum = 16, start, end, ...overrides } = {}) {
  const bytes = encoder.encode(value);
  const result = new Uint8Array(48 + bytes.length);
  const view = new DataView(result.buffer);
  const words = [
    1,
    id,
    0,
    1,
    maximum,
    bytes.length,
    start ?? bytes.length,
    end ?? bytes.length,
    100,
    80,
    200,
    30,
  ];
  for (const [index, word] of words.entries()) {
    view.setUint32(index * 4, overrides[index] ?? word, true);
  }
  result.set(bytes, 48);
  return result;
}
function setup() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  const notifications = [];
  const session = createTextInputSession(() => ({ memory }), {
    onConfigure: (state) => notifications.push(state),
  });
  const configure = (bytes) => {
    new Uint8Array(memory.buffer, 128, bytes.length).set(bytes);
    return session.imports.text_configure(128, bytes.length);
  };
  return { memory, session, notifications, configure };
}

test("native SDL suite serializes tests to avoid the global-state race", () => {
  const args = nativeTestArgs({ dependencies: "deps", output: "native-tests.exe" });
  assert.deepEqual(
    args.filter((arg) => arg.startsWith("-define:ODIN_TEST_THREADS=")),
    ["-define:ODIN_TEST_THREADS=1"],
    "SDL global-state race: parallel Init/Quit can tear down another native test's subsystem",
  );
});

test("text configuration owns UTF8, reads once per tick and retains the field", () => {
  const { memory, session, configure } = setup();
  assert.equal(configure(packet("é😀")), 1);
  new Uint8Array(memory.buffer, 128, 54).fill(0);
  assert.equal(session.snapshot().value, "é😀");
  assert.equal(session.imports.text_read(512, 53), 0, "short destination does not consume");
  assert.equal(session.imports.text_read(512, 305), 0, "unbounded capacity rejected");
  assert.equal(session.imports.text_read(512, 304), 54);
  assert.deepEqual(
    [...new Uint32Array(memory.buffer, 512, 12)],
    [1, 7, 1, 1, 16, 6, 6, 6, 100, 80, 200, 30],
  );
  assert.deepEqual([...new Uint8Array(memory.buffer, 560, 6)], [195, 169, 240, 159, 152, 128]);
  assert.equal(session.imports.text_read(512, 304), 0);
  session.beginTick();
  memory.grow(1);
  assert.equal(session.imports.text_read(70000, 304), 54, "grown memory is resolved afresh");
});

test("malformed text configuration is atomic and cannot close an active field", () => {
  const { memory, session, notifications, configure } = setup();
  assert.equal(configure(packet("ready")), 1);
  const before = session.snapshot();
  for (const bytes of [
    packet("é", { start: 1 }),
    packet("bad\n"),
    packet("toolong", { maximum: 2 }),
    packet("x", { 2: 1 }),
    packet("x", { 3: 3 }),
    packet("x", { 10: 0 }),
    packet("x", { 8: 4097 }),
    packet("x", { 0: 2 }),
    packet("", { id: 0 }),
    Uint8Array.of(...packet(""), 0),
  ]) {
    assert.equal(configure(bytes), 0);
    assert.deepEqual(session.snapshot(), before);
  }
  const invalidUtf8 = packet("ab");
  invalidUtf8.set([0xc0, 0xaf], 48);
  assert.equal(configure(invalidUtf8), 0);
  assert.equal(session.imports.text_configure(memory.buffer.byteLength - 2, 48), 0);
  assert.equal(notifications.length, 1);
  const close = new Uint8Array(48);
  close[0] = 1;
  assert.equal(configure(close), 1);
  assert.equal(session.snapshot(), null);
  assert.equal(session.imports.text_read(512, 304), 0);
});

test("generation and sequence reject stale edits; terminal value survives consumption", () => {
  const { memory, session, configure } = setup();
  configure(packet("one"));
  const first = session.snapshot();
  const update = {
    id: first.id,
    revision: first.revision,
    sequence: 1,
    value: "é",
    start: 2,
    end: 2,
    flags: 2,
  };
  assert.equal(session.accept(update), true);
  assert.equal(session.accept(update), false);
  assert.equal(session.accept({ ...update, sequence: 2, start: 1 }), false);
  assert.equal(session.accept({ ...update, sequence: 2, value: "\ud800" }), false);
  assert.equal(session.accept({ ...update, sequence: 2, flags: 0x100000002 }), false);
  assert.equal(session.snapshot().value, "é");
  configure(packet("two"));
  assert.equal(session.accept({ ...update, sequence: 3 }), false);
  assert.equal(
    session.accept({ ...update, revision: session.snapshot().revision, sequence: 1, flags: 4 }),
    true,
  );
  assert.equal(session.snapshot().flags, 4);
  assert.equal(
    session.accept({ ...update, revision: session.snapshot().revision, sequence: 2 }),
    false,
  );
  assert.equal(session.imports.text_read(512, 304), 50);
  assert.equal(new DataView(memory.buffer).getUint32(524, true), 4);
  session.beginTick();
  assert.equal(session.imports.text_read(512, 304), 50);
  assert.equal(new DataView(memory.buffer).getUint32(524, true), 0);
  assert.equal(session.snapshot().value, "é");
});

test("real DOM input supports trusted phone focus, UTF8 edits, composition and stale fields", async () => {
  const directory = resolve(repo, "build/text-input-browser", randomUUID());
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, "index.html"),
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{margin:20px}canvas{width:320px;height:180px;background:#222}</style>
  <canvas id="canvas" width="640" height="360" tabindex="0"></canvas>
  <script type="module">
  import {createTextInputOverlay} from '/runtime/odin/web/text-input.js';
  const canvas=document.querySelector('canvas');
  window.messages=[];window.focusEvents=[];
  const overlay=createTextInputOverlay({canvas,logicalSize:()=>[640,360],send:update=>messages.push(update),onEditing:active=>focusEvents.push(active)});
  window.configure=(revision=1,maxBytes=16)=>overlay.configure({id:7,revision,flags:1,maxBytes,value:'',start:0,end:0,x:100,y:80,width:200,height:30});
  window.overlay=overlay;configure();
  </script>`,
  );
  const server = serve(repo, 0);
  await new Promise((accept) => server.once("listening", accept));
  let browser;
  try {
    browser = await chromium.launch({
      channel: process.env.PLAYER_BROWSER_CHANNEL || "chrome",
      headless: true,
    });
    for (const mobile of [false, true]) {
      const context = await browser.newContext({
        viewport: { width: 640, height: 480 },
        ...(mobile ? { isMobile: true, hasTouch: true } : {}),
      });
      const page = await context.newPage();
      await page.goto(
        `http://127.0.0.1:${server.address().port}/build/text-input-browser/${directory.split(/[\\/]/).at(-1)}/index.html`,
      );
      const input = page.locator("input[data-bytorio-text]");
      await input.waitFor();
      const rectangle = await input.boundingBox();
      assert.deepEqual(rectangle, { x: 70, y: 60, width: 100, height: 15 });
      await input.evaluate((element) =>
        element.addEventListener("pointerdown", (event) => {
          globalThis.trustedFocus =
            event.isTrusted && globalThis.document.activeElement === element;
        }),
      );
      await input[mobile ? "tap" : "click"]();
      assert.equal(await page.evaluate(() => globalThis.trustedFocus), true);
      assert.equal(await page.evaluate(() => globalThis.overlay.editing()), true);
      await page.keyboard.type("ABC");
      await page.keyboard.press("Backspace");
      assert.equal(await page.evaluate(() => globalThis.messages.at(-1).value), "AB");
      await input.fill("é😀");
      assert.deepEqual(
        await page.evaluate(() => {
          const { value, start, end } = globalThis.messages.at(-1);
          return { value, start, end };
        }),
        { value: "é😀", start: 6, end: 6 },
      );
      const acceptedCount = await page.evaluate(() => globalThis.messages.length);
      for (const invalid of ["😀".repeat(8), "a".repeat(257), "bad\u0001value"]) {
        await page.keyboard.insertText(invalid);
        assert.equal(await input.inputValue(), "é😀");
        const snapshots = await page.evaluate(
          (from) => globalThis.messages.slice(from),
          acceptedCount,
        );
        for (const snapshot of snapshots) {
          assert.deepEqual(
            [snapshot.value, snapshot.revision, snapshot.flags],
            ["é😀", 1, 2],
            "rejected text never reaches the host; selection-only updates remain valid",
          );
          assert.ok([0, 2, 6].includes(snapshot.start) && [0, 2, 6].includes(snapshot.end));
          assert.ok(snapshot.start <= snapshot.end);
        }
        assert.deepEqual(
          await input.evaluate((element) => [element.selectionStart, element.selectionEnd]),
          [3, 3],
        );
      }
      await input.fill("");
      const cdp = await context.newCDPSession(page);
      const count = await page.evaluate(() => globalThis.messages.length);
      await cdp.send("Input.imeSetComposition", { text: "漢", selectionStart: 1, selectionEnd: 1 });
      assert.equal(await input.inputValue(), "漢", "browser displays the active IME preedit");
      const preeditSnapshots = await page.evaluate(
        (from) => globalThis.messages.slice(from),
        count,
      );
      for (const snapshot of preeditSnapshots) {
        assert.deepEqual(
          [snapshot.value, snapshot.revision, snapshot.flags],
          ["", 1, 2],
          "IME preedit cannot commit text or submit/cancel the field",
        );
      }
      assert.equal(await page.evaluate(() => globalThis.messages.at(-1).value), "");
      await cdp.send("Input.insertText", { text: "漢字" });
      assert.equal(await page.evaluate(() => globalThis.messages.at(-1).value), "漢字");
      await page.keyboard.press("Enter");
      assert.equal(await page.evaluate(() => globalThis.messages.at(-1).flags), 4);
      assert.equal(await page.evaluate(() => globalThis.overlay.editing()), false);
      await page.evaluate(() => {
        globalThis.oldInput = globalThis.document.querySelector("input");
        globalThis.configure(2, 4);
      });
      const before = await page.evaluate(() => globalThis.messages.length);
      await page.evaluate(() => {
        globalThis.oldInput.value = "stale";
        globalThis.oldInput.dispatchEvent(new Event("input"));
      });
      const replacementSnapshots = await page.evaluate(
        (from) => globalThis.messages.slice(from),
        before,
      );
      for (const snapshot of replacementSnapshots) {
        assert.deepEqual(
          [snapshot.value, snapshot.revision, snapshot.flags],
          ["", 2, 2],
          "detached input cannot publish its stale value or generation",
        );
      }
      assert.equal(await input.inputValue(), "", "replacement field retains its own value");
      await input[mobile ? "tap" : "click"]();
      await input.fill("ABCD");
      await input.fill("ABCDZ");
      assert.equal(await input.inputValue(), "ABCD");
      await page.keyboard.press("Escape");
      assert.equal(await page.evaluate(() => globalThis.messages.at(-1).flags), 8);
      await page.evaluate(() => globalThis.overlay.close());
      assert.equal(await input.count(), 0);
      await page.screenshot({ path: resolve(directory, mobile ? "phone.png" : "desktop.png") });
      await context.close();
    }
  } finally {
    try {
      await browser?.close();
    } finally {
      await new Promise((accept) => server.close(accept));
    }
  }
});
