import { createSession } from "./session.js";
export { buttons, buttonMask } from "./input.js";

// The default player and custom hosts share this UI-independent interface.
export function createRuntime({
  canvas,
  frameRate = 60,
  graphics = {},
  diagnostics = false,
  audioContext,
} = {}) {
  return createSession({ canvas, frameRate, graphics, diagnostics, audioContext }).runtime;
}
