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

// Where a touch on the d-pad square lands, as x and y from -1 (left, top) to 1 (right, bottom)
// around its centre, and the direction bits it means.
// The disc reads both axes, so it can hold a diagonal.
export function discDirection(x, y) {
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
  return bits >>> 0;
}

// Half the width of the cross's dead hub, in the same units.
export const HUB = 0.2;

// The cross is four-way: inside the hub nothing is held, anywhere else the axis with the larger
// travel wins, so a corner of the square resolves to the nearer arm and never to two directions.
export function crossDirection(x, y) {
  if (Math.abs(x) <= HUB && Math.abs(y) <= HUB) {
    return 0;
  }
  if (Math.abs(x) > Math.abs(y)) {
    return (x < 0 ? LEFT : RIGHT) >>> 0;
  }
  return (y < 0 ? UP : DOWN) >>> 0;
}

// The arms the cross draws, in the order they appear: name, arrow, bits.
const ARMS = [
  ["up", "▲", UP],
  ["left", "◀", LEFT],
  ["right", "▶", RIGHT],
  ["down", "▼", DOWN],
];

// Selectable d-pad layouts. A new layout is one entry here (its `direction` and, if it draws
// separate parts, `arms`), its look in STYLE under `[data-layout="name"]`, and one test.
export const LAYOUTS = {
  cross: { label: "Cross", direction: crossDirection, arms: true },
  disc: { label: "Disc", direction: discDirection, arms: false },
};
export const DEFAULT_LAYOUT = "cross";
export const LAYOUT_STORAGE_KEY = "bytorio-touch-layout";

// The registry entry for `name`; anything that is not a layout name is the default.
export function layoutFor(name) {
  return typeof name === "string" && Object.hasOwn(LAYOUTS, name)
    ? LAYOUTS[name]
    : LAYOUTS[DEFAULT_LAYOUT];
}
const nameFor = (name) =>
  typeof name === "string" && Object.hasOwn(LAYOUTS, name) ? name : DEFAULT_LAYOUT;

function browserStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

// The layout to start with: the `touch-layout` query parameter, then the stored choice, then the
// default. A name that is not a layout, or storage that cannot be read, means the default.
export function chooseTouchLayout(options = {}) {
  const search = options.search ?? globalThis.location?.search ?? "";
  const storage = "storage" in options ? options.storage : browserStorage();
  const query = new URLSearchParams(search).get("touch-layout");
  if (query !== null) {
    return nameFor(query);
  }
  try {
    const stored = storage?.getItem(LAYOUT_STORAGE_KEY);
    return stored === null || stored === undefined ? DEFAULT_LAYOUT : nameFor(stored);
  } catch {
    return DEFAULT_LAYOUT;
  }
}

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
#touch-controls [data-touch="dpad"][data-layout="cross"]{border:0;border-radius:0;background:none}
#touch-controls [data-touch="dpad"][data-layout="cross"]::before{display:none}
/* The plus fills its square: arms and hub are --arm thick (40%), centred at --edge, and each arm is
   --len long, which is what is left on either side of the hub plus a 1% overlap. */
#touch-controls [data-touch="dpad"][data-layout="cross"]{--arm:40%;--len:31%;--edge:30%}
#touch-controls [data-arm],#touch-controls [data-hub]{position:absolute;display:grid;place-items:center;
  box-sizing:border-box;border:2px solid #dfeae7aa;border-radius:8px;
  background:#10131e99;font-size:18px;pointer-events:none}
#touch-controls [data-hub]{width:var(--arm);height:var(--arm);left:var(--edge);top:var(--edge);
  background:#10131e55;border-color:#dfeae744}
#touch-controls [data-arm="up"],#touch-controls [data-arm="down"]{width:var(--arm);height:var(--len);left:var(--edge)}
#touch-controls [data-arm="left"],#touch-controls [data-arm="right"]{width:var(--len);height:var(--arm);top:var(--edge)}
#touch-controls [data-arm="up"]{top:0}
#touch-controls [data-arm="down"]{bottom:0}
#touch-controls [data-arm="left"]{left:0}
#touch-controls [data-arm="right"]{right:0}
#touch-controls [data-arm].pressed{background:#70f0c0cc;color:#10131e}
#touch-controls [data-touch="dpad"]::before{content:"";position:absolute;inset:0;border-radius:50%;
  background:linear-gradient(#dfeae755,#dfeae755) center/60% 2px no-repeat,
  linear-gradient(#dfeae755,#dfeae755) center/2px 60% no-repeat;pointer-events:none}
@media (orientation:landscape){
  #touch-controls{--col:102px;--gap:8px;--pad:clamp(44px,calc(var(--col) - 2*var(--gap)),144px);
    --size:clamp(44px,calc(var(--col) - 2*var(--gap)),64px);--wide:clamp(44px,calc(var(--col) - 2*var(--gap)),88px);
    position:fixed;inset:0;pointer-events:none}
  #touch-controls [data-touch="dpad"]{width:var(--pad);height:var(--pad);
    left:calc((var(--col) - var(--pad)) / 2 + env(safe-area-inset-left));bottom:var(--gap)}
  #touch-controls [data-touch="l"]{width:var(--wide);left:calc((var(--col) - var(--wide)) / 2 + env(safe-area-inset-left));top:var(--gap)}
  #touch-controls [data-touch="r"]{width:var(--wide);right:calc((var(--col) - var(--wide)) / 2 + env(safe-area-inset-right));top:var(--gap)}
  #touch-controls [data-touch="start"]{width:var(--wide);font-size:12px;
    right:calc((var(--col) - var(--wide)) / 2 + env(safe-area-inset-right));top:calc(2*var(--gap) + ${MIN_TARGET}px)}
  #touch-controls [data-touch="full"]{width:var(--wide);font-size:12px;
    left:calc((var(--col) - var(--wide)) / 2 + env(safe-area-inset-left));top:calc(2*var(--gap) + ${MIN_TARGET}px)}
  #touch-controls [data-touch="b"]{right:calc((var(--col) - var(--size)) / 2 + env(safe-area-inset-right));
    bottom:calc(2*var(--gap) + var(--size))}
  #touch-controls [data-touch="a"]{right:calc((var(--col) - var(--size)) / 2 + env(safe-area-inset-right));bottom:var(--gap)}
}
@media (orientation:portrait){
  #touch-controls [data-touch="full"]{display:none}
  #touch-controls{position:relative;width:100%;min-width:320px;height:${PANEL_HEIGHT}px;margin-top:${MARGIN}px}
  #touch-controls [data-touch="dpad"]{left:${MARGIN}px;bottom:${MARGIN}px}
  #touch-controls [data-touch="a"]{right:${MARGIN}px;bottom:${MARGIN}px}
  #touch-controls [data-touch="b"]{right:calc(${MARGIN}px + var(--size) + 12px);bottom:${MARGIN + 36}px}
  #touch-controls [data-touch="start"]{left:50%;top:0;transform:translateX(-50%)}
  #touch-controls [data-touch="l"]{left:${MARGIN}px;top:0}
  #touch-controls [data-touch="r"]{right:${MARGIN}px;top:0}
}`;

// What each active pointer holds, so two thumbs combine and a lifted one releases only its own.
const held = new Map();
let root;
let layoutName = DEFAULT_LAYOUT;
let shown = false;
let onLayout = () => {};
let onActivate = () => {};
let onFullscreen = () => {};

// Union of everything currently held, as an unsigned 32-bit mask.
export function touchButtons() {
  let mask = 0;
  for (const { bits } of held.values()) {
    mask |= bits;
  }
  return mask >>> 0;
}

// Widest and narrowest column landscape leaves for the controls beside the canvas.
const MIN_COLUMN = 84;
const MAX_COLUMN = 150;

// Below this share of the free room, whole device pixels waste too much of a phone's screen, so
// the canvas scales to the room instead. Fractional scaling gives slightly uneven pixel widths on
// a 2x screen (the canvas stays pixelated); a 3x screen hides it.
const MIN_FILL = 0.85;

// The canvas scale for `fit` (the largest scale the room allows, in device pixels per game pixel):
// whole numbers when they fill most of the room, the exact fit when they would not.
export function touchScale(fit) {
  const whole = Math.floor(fit);
  return fit >= 1 && whole >= MIN_FILL * fit ? whole : Math.max(0.25, fit);
}

// Lays the controls out for a canvas of `logical` size and returns what the player must leave free
// around it instead of its fixed space for the page's own controls, or null while the overlay is
// hidden. Portrait leaves the panel's height below the canvas. Landscape gives each side a column
// for the controls and the canvas fits between them: the column is whatever the canvas, scaled as
// the player scales it, leaves over, within MIN_COLUMN and MAX_COLUMN.
export function touchLayout({ width, height }) {
  if (!shown) {
    return null;
  }
  if (matchMedia("(orientation: portrait)").matches) {
    return { width: 2 * MARGIN, height: PANEL_HEIGHT + 2 * MARGIN };
  }
  const density = devicePixelRatio || 1;
  const fit = Math.min(
    ((innerWidth - 2 * MIN_COLUMN) * density) / width,
    ((innerHeight - MARGIN) * density) / height,
  );
  const scale = touchScale(fit);
  const column = Math.min(
    MAX_COLUMN,
    Math.max(MIN_COLUMN, (innerWidth - (width * scale) / density) / 2),
  );
  root.style.setProperty("--col", `${column}px`);
  return { width: 2 * column, height: MARGIN };
}

function paint() {
  for (const element of root?.querySelectorAll("[data-touch]") ?? []) {
    const entries = [...held.values()].filter((entry) => entry.element === element);
    const split = element.dataset.touch === "dpad" && layoutFor(layoutName).arms;
    // A layout with arms lights only the arms being pressed; the rest light as one piece.
    element.classList.toggle("pressed", entries.length > 0 && !split);
    if (split) {
      for (const [name, , bits] of ARMS) {
        const lit = entries.some((entry) => (entry.bits & bits) === bits);
        element.querySelector(`[data-arm="${name}"]`)?.classList.toggle("pressed", lit);
      }
    }
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
  return layoutFor(layoutName).direction(x, y);
}

// Redraws the d-pad's parts for the active layout.
function fillDpad(dpad) {
  dpad.dataset.layout = layoutName;
  dpad.replaceChildren();
  if (layoutFor(layoutName).arms) {
    for (const [name, arrow] of ARMS) {
      const arm = document.createElement("div");
      arm.dataset.arm = name;
      arm.textContent = arrow;
      dpad.append(arm);
    }
    const hub = document.createElement("div");
    hub.dataset.hub = "";
    dpad.append(hub);
  }
}

// Switches the d-pad layout now, without touching the page or the game, and remembers the choice
// where the browser allows it. Anything held is released, because its meaning just changed. Returns
// the layout in use, which is the default for a name that is not a layout.
export function setTouchLayout(name) {
  layoutName = nameFor(name);
  try {
    globalThis.localStorage?.setItem(LAYOUT_STORAGE_KEY, layoutName);
  } catch {
    // The choice just lasts until the page closes.
  }
  const dpad = root?.querySelector('[data-touch="dpad"]');
  if (dpad) {
    releaseTouchControls();
    fillDpad(dpad);
    onLayout();
  }
  return layoutName;
}

export const touchLayoutName = () => layoutName;

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
  fillDpad(dpad);
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
  if (document.fullscreenEnabled) {
    // The page's own Fullscreen button falls below a landscape phone's screen.
    const full = document.createElement("div");
    full.dataset.touch = "full";
    full.setAttribute("role", "button");
    full.setAttribute("aria-label", "Fullscreen");
    full.textContent = "FULL";
    full.addEventListener("pointerup", () => onFullscreen());
    full.addEventListener("contextmenu", (event) => event.preventDefault());
    root.append(full);
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

// `onActivate` runs when a touch is lifted on the canvas or a control; `onFullscreen` when the
// FULL button is lifted.
// Builds the overlay inside `parent` on touch devices: at once for a coarse primary pointer,
// otherwise on the first touch. A mouse-only page gets no elements and no listeners that matter.
export function installTouchControls({
  parent,
  onLayout: layout = () => {},
  onActivate: activate = () => {},
  onFullscreen: fullscreen = () => {},
}) {
  onLayout = layout;
  layoutName = chooseTouchLayout();
  onActivate = activate;
  onFullscreen = fullscreen;
  // Lifting a finger anywhere on the screen or the controls is a user gesture, so the host can
  // start or resume the game (and unlock audio) as its own Start button does. Mouse clicks keep
  // their existing behaviour.
  parent.addEventListener("pointerup", (event) => {
    if (event.pointerType === "touch") {
      onActivate();
    }
  });
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

// Whether the overlay is up, for wording such as the page's help line.
export const touchShown = () => shown;
