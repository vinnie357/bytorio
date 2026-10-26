import * as controls from "./constants.js";

// Pointer travel, as a fraction of the d-pad radius, before a direction counts as held.
export const DPAD_DEADZONE = 0.33;
// Controls are never smaller than this many CSS pixels on a side.
export const MIN_TARGET = 44;
// Height of the portrait control panel below the canvas, and the gap around the canvas.
const PANEL_HEIGHT = 224;
const MARGIN = 16;

// The same bits gamepad.js sends. The d-pad sets the original direction bit and the move bit so
// older SDKs keep working.
const LEFT = 1 | controls.BUTTON_MOVE_LEFT;
const RIGHT = 2 | controls.BUTTON_MOVE_RIGHT;
const UP = 4 | controls.BUTTON_MOVE_UP;
const DOWN = 8 | controls.BUTTON_MOVE_DOWN;
const BUTTONS = [
  ["l", "L", controls.BUTTON_ROTATE_LEFT],
  ["r", "R", controls.BUTTON_ROTATE_RIGHT],
  ["start", "START", controls.BUTTON_MAP],
  ["b", "B", controls.BUTTON_ESCAPE],
  ["a", "A", 16],
];

const STYLE = `
#touch-controls{--size:64px;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;
  touch-action:none;font:600 14px system-ui,sans-serif;z-index:10}
#touch-controls [data-touch]{position:absolute;display:grid;place-items:center;box-sizing:border-box;
  min-width:${MIN_TARGET}px;min-height:${MIN_TARGET}px;margin:0;padding:0;border:2px solid #dfeae7aa;
  border-radius:12px;background:#10131e99;color:#dfeae7;touch-action:none;pointer-events:auto;
  cursor:default}
#touch-controls [data-touch].pressed{background:#70f0c0cc;color:#10131e}
#touch-controls [data-touch="a"],#touch-controls [data-touch="b"]{width:var(--size);height:var(--size);
  border-radius:50%}
#touch-controls [data-touch="start"]{width:88px;height:${MIN_TARGET}px}
#touch-controls [data-touch="l"],#touch-controls [data-touch="r"]{width:72px;height:${MIN_TARGET}px}
#touch-controls [data-touch="dpad"]{width:144px;height:144px;border-radius:50%;
  background:radial-gradient(#10131e99 0 28%,#10131e66 29%)}
#touch-controls [data-touch="dpad"]::before{content:"";position:absolute;inset:0;border-radius:50%;
  background:linear-gradient(#dfeae755,#dfeae755) center/60% 2px no-repeat,
  linear-gradient(#dfeae755,#dfeae755) center/2px 60% no-repeat;pointer-events:none}
@media (orientation:landscape){
  #touch-controls{position:fixed;inset:0;pointer-events:none;
    padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
  #touch-controls [data-touch="dpad"]{left:calc(${MARGIN}px + env(safe-area-inset-left));bottom:${MARGIN}px}
  #touch-controls [data-touch="a"]{right:calc(${MARGIN}px + env(safe-area-inset-right));bottom:${MARGIN}px}
  #touch-controls [data-touch="b"]{right:calc(${MARGIN}px + var(--size) + 12px + env(safe-area-inset-right));bottom:${MARGIN + 36}px}
  #touch-controls [data-touch="start"]{left:50%;bottom:${MARGIN}px;transform:translateX(-50%)}
  #touch-controls [data-touch="l"]{left:calc(${MARGIN}px + env(safe-area-inset-left));top:${MARGIN}px}
  #touch-controls [data-touch="r"]{right:calc(${MARGIN}px + env(safe-area-inset-right));top:${MARGIN}px}
}
@media (orientation:portrait){
  #touch-controls{position:relative;width:100%;min-width:320px;height:${PANEL_HEIGHT}px;margin-top:${MARGIN}px}
  #touch-controls [data-touch="dpad"]{left:${MARGIN}px;bottom:${MARGIN}px}
  #touch-controls [data-touch="a"]{right:${MARGIN}px;bottom:${MARGIN}px}
  #touch-controls [data-touch="b"]{right:calc(${MARGIN}px + var(--size) + 12px);bottom:${MARGIN + 36}px}
  #touch-controls [data-touch="start"]{left:50%;bottom:${MARGIN}px;transform:translateX(-50%)}
  #touch-controls [data-touch="l"]{left:${MARGIN}px;top:0}
  #touch-controls [data-touch="r"]{right:${MARGIN}px;top:0}
}`;

// What each active pointer holds, so two thumbs combine and a lifted one releases only its own.
const held = new Map();
let root;
let shown = false;
let onLayout = () => {};

// Union of everything currently held, as an unsigned 32-bit mask.
export function touchButtons() {
  let mask = 0;
  for (const { bits } of held.values()) {
    mask |= bits;
  }
  return mask >>> 0;
}

// What replaces the fixed space the player reserves around the canvas (the page's own controls)
// while the overlay is up, or null when it is hidden. Portrait leaves the panel's height below the
// canvas; landscape draws over the page, so only a small margin remains.
export function touchLayoutReserve() {
  if (!shown) {
    return null;
  }
  return matchMedia("(orientation: portrait)").matches ? PANEL_HEIGHT + 2 * MARGIN : MARGIN;
}

function paint() {
  for (const element of root?.querySelectorAll("[data-touch]") ?? []) {
    const active = [...held.values()].some((entry) => entry.element === element);
    element.classList.toggle("pressed", active);
  }
}
function release(id) {
  if (held.delete(id)) {
    paint();
  }
}
export function releaseTouchControls() {
  held.clear();
  paint();
}

function dpadBits(element, event) {
  const rectangle = element.getBoundingClientRect();
  const x = (event.clientX - (rectangle.left + rectangle.width / 2)) / (rectangle.width / 2);
  const y = (event.clientY - (rectangle.top + rectangle.height / 2)) / (rectangle.height / 2);
  let bits = 0;
  if (x < -DPAD_DEADZONE) {
    bits |= LEFT;
  }
  if (x > DPAD_DEADZONE) {
    bits |= RIGHT;
  }
  if (y < -DPAD_DEADZONE) {
    bits |= UP;
  }
  if (y > DPAD_DEADZONE) {
    bits |= DOWN;
  }
  return bits;
}

function track(element, bitsFor) {
  const update = (event) => {
    held.set(event.pointerId, { bits: bitsFor(event), element });
    paint();
  };
  element.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    element.setPointerCapture(event.pointerId);
    update(event);
  });
  element.addEventListener("pointermove", (event) => {
    if (held.has(event.pointerId)) {
      update(event);
    }
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    element.addEventListener(type, (event) => release(event.pointerId));
  }
  element.addEventListener("contextmenu", (event) => event.preventDefault());
}

function build(parent) {
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);
  root = document.createElement("div");
  root.id = "touch-controls";
  root.setAttribute("aria-label", "Touch controls");
  const dpad = document.createElement("div");
  dpad.dataset.touch = "dpad";
  dpad.setAttribute("role", "group");
  dpad.setAttribute("aria-label", "Direction pad");
  track(dpad, (event) => dpadBits(dpad, event));
  root.append(dpad);
  for (const [name, label, bits] of BUTTONS) {
    const button = document.createElement("div");
    button.dataset.touch = name;
    button.setAttribute("role", "button");
    button.setAttribute("aria-label", label);
    button.textContent = label;
    track(button, () => bits);
    root.append(button);
  }
  parent.append(root);
}

function show(parent) {
  if (shown) {
    return;
  }
  shown = true;
  if (!root) {
    build(parent);
  }
  root.hidden = false;
  onLayout();
}

// Builds the overlay inside `parent` on touch devices: at once for a coarse primary pointer,
// otherwise on the first touch. A mouse-only page gets no elements and no listeners that matter.
export function installTouchControls({ parent, onLayout: layout = () => {} }) {
  onLayout = layout;
  const coarse = matchMedia("(pointer: coarse)");
  if (coarse.matches) {
    show(parent);
  }
  addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType === "touch") {
        show(parent);
      }
    },
    { capture: true },
  );
  matchMedia("(orientation: portrait)").addEventListener("change", () => onLayout());
  // Nothing stays held when the page loses the screen.
  addEventListener("blur", releaseTouchControls);
  document.addEventListener("visibilitychange", releaseTouchControls);
  addEventListener("pagehide", releaseTouchControls);
}
