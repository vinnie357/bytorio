import * as controls from "./constants.js";

// Left-stick travel, out of 1, before a direction counts as held.
export const STICK_DEADZONE = 0.4;

// Standard-mapping button index and the bits it sends. The d-pad sets the
// original direction bit and the move bit so older SDKs keep working.
const BUTTONS = [
  [0, 16],
  [1, controls.BUTTON_ESCAPE],
  [4, controls.BUTTON_ROTATE_LEFT],
  [5, controls.BUTTON_ROTATE_RIGHT],
  [9, controls.BUTTON_MAP],
  [12, 4 | controls.BUTTON_MOVE_UP],
  [13, 8 | controls.BUTTON_MOVE_DOWN],
  [14, 1 | controls.BUTTON_MOVE_LEFT],
  [15, 2 | controls.BUTTON_MOVE_RIGHT],
];

// Translate the first standard-mapping gamepad into the shared button mask.
export function gamepadButtons(getGamepads = () => navigator.getGamepads?.() || []) {
  const pad = [...getGamepads()].find((pad) => pad?.connected && pad.mapping === "standard");
  if (!pad) {
    return 0;
  }
  let mask = 0;
  for (const [index, bits] of BUTTONS) {
    if (pad.buttons[index]?.pressed) {
      mask |= bits;
    }
  }
  const x = pad.axes[0] || 0;
  const y = pad.axes[1] || 0;
  if (x < -STICK_DEADZONE) {
    mask |= 1 | controls.BUTTON_MOVE_LEFT;
  }
  if (x > STICK_DEADZONE) {
    mask |= 2 | controls.BUTTON_MOVE_RIGHT;
  }
  if (y < -STICK_DEADZONE) {
    mask |= 4 | controls.BUTTON_MOVE_UP;
  }
  if (y > STICK_DEADZONE) {
    mask |= 8 | controls.BUTTON_MOVE_DOWN;
  }
  return mask >>> 0;
}
