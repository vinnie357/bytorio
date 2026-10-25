import * as controls from "./constants.js";

// Left-stick travel, out of 1, before a direction counts as held.
export const STICK_DEADZONE = 0.4;

// Translate the first standard-mapping gamepad into the shared button mask.
export function gamepadButtons(getGamepads = () => navigator.getGamepads?.() || []) {
  return 0;
}
