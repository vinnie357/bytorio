import assert from "node:assert/strict";
import test from "node:test";
import * as controls from "../runtime/odin/web/constants.js";
import { gamepadButtons } from "../runtime/odin/web/gamepad.js";

// A stub of navigator.getGamepads() holding one standard-mapping pad.
function stub({ pressed = [], axes = [0, 0, 0, 0], mapping = "standard", connected = true } = {}) {
  const buttons = Array.from({ length: 17 }, (_, index) => ({ pressed: pressed.includes(index) }));
  return () => [null, { connected, mapping, buttons, axes }];
}

test("no pad reads as zero", () => {
  assert.equal(gamepadButtons(() => []), 0);
  assert.equal(gamepadButtons(() => [null]), 0);
  assert.equal(gamepadButtons(stub({ connected: false })), 0);
  assert.equal(gamepadButtons(stub({ pressed: [0], mapping: "" })), 0);
});

test("face, shoulder, start and d-pad buttons map to the shared bits", () => {
  const cases = [
    [0, 16],
    [1, controls.BUTTON_ESCAPE],
    [4, controls.BUTTON_ROTATE_LEFT],
    [5, controls.BUTTON_ROTATE_RIGHT],
    [9, controls.BUTTON_MAP],
    [14, 1 | controls.BUTTON_MOVE_LEFT],
    [15, 2 | controls.BUTTON_MOVE_RIGHT],
    [12, 4 | controls.BUTTON_MOVE_UP],
    [13, 8 | controls.BUTTON_MOVE_DOWN],
  ];
  for (const [index, mask] of cases) {
    assert.equal(gamepadButtons(stub({ pressed: [index] })), mask >>> 0, `button ${index}`);
  }
});

test("the left stick maps past the deadzone and rests inside it", () => {
  const left = (1 | controls.BUTTON_MOVE_LEFT) >>> 0;
  const down = (8 | controls.BUTTON_MOVE_DOWN) >>> 0;
  assert.equal(gamepadButtons(stub({ axes: [-0.9, 0, 0, 0] })), left);
  assert.equal(gamepadButtons(stub({ axes: [0.9, 0, 0, 0] })), (2 | controls.BUTTON_MOVE_RIGHT) >>> 0);
  assert.equal(gamepadButtons(stub({ axes: [0, -0.9, 0, 0] })), (4 | controls.BUTTON_MOVE_UP) >>> 0);
  assert.equal(gamepadButtons(stub({ axes: [-0.9, 0.9, 0, 0] })), (left | down) >>> 0);
  assert.equal(gamepadButtons(stub({ axes: [0.3, -0.3, 0, 0] })), 0);
  assert.equal(gamepadButtons(stub({ axes: [0, 0, -0.9, 0.9] })), 0, "the right stick is ignored");
});

test("the result is an unsigned 32-bit mask", () => {
  assert.ok(gamepadButtons(stub({ pressed: [1] })) > 0);
});
