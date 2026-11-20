import assert from "node:assert/strict";
import test from "node:test";
import { createInputState, buttons } from "../runtime/odin/web/input.js";
import { normalizePlayerConfig } from "../runtime/odin/web/player-config.js";

test("sources aggregate without releasing other holds; pulses survive render-only frames", () => {
  const input = createInputState();
  input.set("keyboard", { buttons: ["right"] });
  input.set("touch", { buttons: ["right", "action"] });
  input.set("keyboard", null);
  assert.equal(input.sample(320, 180).buttons, buttons.right | buttons.action);
  input.pulse(["wheel_up"]);
  assert.ok(input.sample(320, 180, false).buttons & buttons.wheel_up);
  assert.ok(input.sample(320, 180, true).buttons & buttons.wheel_up);
  assert.equal(input.sample(320, 180).buttons & buttons.wheel_up, 0);
  input.clear();
  assert.equal(input.sample(320, 180).buttons, 0);
});

test("pointer selection preserves first held contact, clips hover and rejects invalid coordinates", () => {
  const input = createInputState();
  input.set("touch1", { pointer: { x: 20, y: 30, down: true } });
  input.set("touch2", { pointer: { x: 50, y: 60, down: true } });
  input.set("mouse", { pointer: { x: 80, y: 90 } });
  assert.deepEqual(input.sample(320, 180), {
    buttons: buttons.pointer_hover | buttons.pointer_left,
    pointer: true,
    x: 20,
    y: 30,
  });
  input.set("touch1", null);
  assert.equal(input.sample(320, 180).x, 50);
  input.set("touch2", { pointer: { x: -1, y: 10, down: true } });
  assert.equal(input.sample(320, 180).pointer, false);
  assert.throws(() => input.set("invalid", { pointer: { x: NaN, y: 0 } }));
  assert.throws(() => input.set("invalid", { buttons: ["typo"] }));
  input.clear();
  for (let i = 0; i < 64; i++) {
    input.set(String(i), { buttons: [] });
  }
  assert.throws(() => input.set("overflow", { buttons: [] }), RangeError);
});

test("presets, binding overrides and explicit layouts use the same validated contract", () => {
  const defaults = normalizePlayerConfig();
  assert.deepEqual(normalizePlayerConfig(JSON.parse(JSON.stringify(defaults))), defaults);
  assert.equal(defaults.controls.layout.length, 5);
  const custom = normalizePlayerConfig({
    controls: { overrides: { action: { label: "Jump", bindings: ["action", "reset"] } } },
  });
  assert.equal(custom.controls.layout[4].label, "Jump");
  assert.equal(custom.controls.layout[4].bindings, buttons.action | buttons.reset);
  const explicit = normalizePlayerConfig({
    controls: {
      layout: [{ id: "inventory", label: "Bag", bindings: ["inventory"], column: 9, row: 1 }],
    },
  });
  assert.equal(explicit.controls.layout.length, 1);
  assert.equal(explicit.controls.layout[0].bindings, buttons.inventory);
  for (const config of [
    { controls: { preset: "analog" } },
    { controls: { overrides: { missing: { label: "Oops" } } } },
    { controls: { layout: [{ id: "bad", label: "Bad", bindings: [], column: 12, row: 1 }] } },
    { controls: { layout: [{ id: "bad", label: "Bad", bindings: ["typo"], column: 1, row: 1 }] } },
    { controls: { visibility: "sometimes" } },
    { controls: { pointer: "yes" } },
    { typo: true },
  ]) {
    assert.throws(() => normalizePlayerConfig(config));
  }
});
