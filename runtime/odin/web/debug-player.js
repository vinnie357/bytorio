import { PLAYER_TITLE } from "./constants.js";
import { normalizeGraphics } from "./gpu.js";
import * as controls from "./constants.js";
import { parseFrameRate } from "./frame-clock.js";
import { createSession } from "./session.js";
const canvas = document.getElementById("canvas");
const button = document.getElementById("start");
const status = document.getElementById("status");
const parameters = new URLSearchParams(location.search);
if (document.title === "Game player") {
  document.title = PLAYER_TITLE;
}
const smoke = parameters.has("smoke");

let renderFps = 60;
let timingError = "";
try {
  renderFps = parseFrameRate(parameters.get("fps") ?? "60");
} catch (error) {
  timingError = error.message;
}
const frameRateControl = document.getElementById("frame-rate");
const frameRateCap = document.getElementById("frame-rate-cap");
const frameRateSetting = () =>
  renderFps < 0 ? "uncapped" : renderFps === 0 ? "native" : renderFps;
frameRateControl.value = renderFps > 0 ? "capped" : frameRateSetting();
frameRateCap.value = renderFps > 0 ? String(renderFps) : "60";
frameRateCap.disabled = renderFps <= 0;
function changeFrameRate() {
  const value = frameRateControl.value === "capped" ? frameRateCap.value : frameRateControl.value;
  try {
    renderFps = parseFrameRate(value);
    frameRateCap.setCustomValidity("");
  } catch (error) {
    frameRateCap.setCustomValidity(error.message);
    frameRateCap.reportValidity();
    return;
  }
  frameRateCap.disabled = renderFps <= 0;
  session.runtime.setFrameRate(frameRateSetting());
  const url = new URL(location.href);
  url.searchParams.set("fps", String(frameRateSetting()));
  history.replaceState(null, "", url);
}
frameRateControl.addEventListener("change", changeFrameRate);
frameRateCap.addEventListener("change", changeFrameRate);

const mib = (bytes) => (bytes / 1048576).toFixed(2);
let graphics = { backend: "cpu", ssaa: "off", pixelSnap: false, smoothPan: false };
try {
  graphics = normalizeGraphics(JSON.parse(localStorage.getItem("graphics-v1") || "{}"));
} catch {
  /* Storage may be unavailable or contain old/invalid preferences. */
}
let graphicsError = "";
try {
  const selected =
    parameters.get("renderer") === "cpu"
      ? { ...graphics, residentMeshes: false, surfaceSamples: false }
      : graphics;
  graphics = normalizeGraphics({
    ...selected,
    backend: parameters.get("renderer") || selected.backend,
    ssaa: parameters.get("ssaa") || selected.ssaa,
    pixelSnap: parameters.has("pixel-snap") || selected.pixelSnap,
    smoothPan: parameters.has("smooth-pan") || selected.smoothPan,
    residentMeshes: parameters.has("gpu-meshes") || selected.residentMeshes,
    surfaceSamples: parameters.has("surface-samples") || selected.surfaceSamples,
  });
} catch (error) {
  graphicsError = error.message;
}
const graphicsBackend = document.getElementById("graphics-backend");
const graphicsSsaa = document.getElementById("graphics-ssaa");
const graphicsSnap = document.getElementById("graphics-snap");
const graphicsSmooth = document.getElementById("graphics-smooth");
const graphicsResident = document.getElementById("graphics-resident");
const graphicsSurface = document.getElementById("graphics-surface");
graphicsBackend.value = graphics.backend;
graphicsSsaa.value = graphics.ssaa;
graphicsSnap.checked = graphics.pixelSnap;
graphicsSmooth.checked = graphics.smoothPan;
graphicsResident.checked = graphics.residentMeshes;
graphicsSurface.checked = graphics.surfaceSamples;
const syncGraphicsControls = () => {
  const cpu = graphicsBackend.value === "cpu";
  graphicsResident.disabled = cpu;
  graphicsSurface.disabled = cpu;
  graphicsSnap.disabled = !cpu && graphicsSurface.checked;
  if (cpu) {
    graphicsResident.checked = false;
    graphicsSurface.checked = false;
  }
  if (graphicsSurface.checked) {
    graphicsResident.checked = true;
    graphicsSnap.checked = true;
    graphicsResident.disabled = true;
  }
};
graphicsBackend.addEventListener("change", syncGraphicsControls);
graphicsSurface.addEventListener("change", syncGraphicsControls);
syncGraphicsControls();
document.getElementById("graphics-apply").addEventListener("click", () => {
  graphics = normalizeGraphics({
    backend: graphicsBackend.value,
    ssaa: graphicsSsaa.value,
    pixelSnap: graphicsSnap.checked,
    smoothPan: graphicsSmooth.checked,
    residentMeshes: graphicsResident.checked,
    surfaceSamples: graphicsSurface.checked,
  });
  try {
    localStorage.setItem("graphics-v1", JSON.stringify(graphics));
  } catch {
    /* Session settings still apply. */
  }
  load(session.runtime.state === "running").catch((error) => fail(error.message));
});

const keys = new Set();
const pointer = { pointer: false, hover: false, right: false, x: 0, y: 0 };
let wheelDirection = 0;
let selection = 0;
let selectedCartridge = null;
const session = createSession({
  canvas,
  smoke,
  graphics,
  frameRate: frameRateSetting(),
  readInput: input,
  resetInput() {
    keys.clear();
    pointer.pointer = pointer.right = pointer.hover = false;
    wheelDirection = 0;
  },
  presentationSize: displayPixels,
  inspect({ status: state, audio }) {
    globalThis.playerStatus = state;
    globalThis.playerAudio = audio;
    status.textContent =
      state.error ||
      (state.state === "loading"
        ? "Loading game…"
        : globalThis.playerInstructions || "Arrows / WASD: move · Space / tap: sound");
    button.disabled = state.state === "loading";
    button.textContent =
      state.state === "failed"
        ? "Restart game"
        : state.state === "running"
          ? "Game running"
          : "Start game";
    if (state.title) {
      document.title = state.title;
    }
    if (state.graphics) {
      document.getElementById("graphics-status").textContent =
        "Active renderer: " +
        state.graphics.effective +
        (state.graphics.fallback ? " · " + state.graphics.fallback : "");
    }
    if (state.metrics) {
      document.getElementById("performance").textContent =
        "Render " +
        state.metrics.renderMs.toFixed(1) +
        " ms · GPU meshes " +
        mib(state.metrics.gpuCacheBytes) +
        " MiB";
    }
    resize();
  },
});
globalThis.playerStatus = session.runtime.getSnapshot();
globalThis.playerAudio = session.inspect().audio;
function fail(message) {
  globalThis.playerStatus = { ...globalThis.playerStatus, error: message, ready: false };
  status.textContent = message;
  button.disabled = false;
}
async function start() {
  if (!session.runtime.getSnapshot().ready) {
    await load();
  }
  await session.runtime.play();
  canvas.focus();
}
async function load(resume = false) {
  if (parameters.has("local") && !selectedCartridge) {
    status.textContent = "Choose a PNG cartridge from your device to begin.";
    button.disabled = true;
    return;
  }
  await session.runtime.load(
    selectedCartridge || parameters.get("game") || globalThis.playerCartridge || "./game.wasm",
    { graphics },
  );
  if (resume) {
    await start();
  }
}
async function openCartridge(file) {
  if (!file) {
    return;
  }
  const currentSelection = ++selection;
  if (!file.size || file.size > controls.MAX_CARTRIDGE_BYTES) {
    fail("PNG cartridge exceeds its container size limit.");
    return;
  }
  try {
    if (currentSelection !== selection) {
      return;
    }
    selectedCartridge = file;
    await load();
  } catch (error) {
    if (currentSelection === selection) {
      fail(error.message);
    }
  }
}
document.getElementById("cartridge").addEventListener("change", (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  openCartridge(file);
});
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => {
  event.preventDefault();
  openCartridge(event.dataTransfer.files[0]);
});

function input(consumeWheel = true) {
  if (session.runtime.getSnapshot().textEditing) {
    return { buttons: 0, pointer: false, x: 0, y: 0 };
  }
  let buttons = 0;
  for (const [key, mask] of [
    ["KeyA", controls.BUTTON_MOVE_LEFT],
    ["KeyD", controls.BUTTON_MOVE_RIGHT],
    ["KeyW", controls.BUTTON_MOVE_UP],
    ["KeyS", controls.BUTTON_MOVE_DOWN],
    ["ArrowLeft", controls.BUTTON_PAN_LEFT],
    ["ArrowRight", controls.BUTTON_PAN_RIGHT],
    ["ArrowUp", controls.BUTTON_PAN_UP],
    ["ArrowDown", controls.BUTTON_PAN_DOWN],
    ["KeyQ", controls.BUTTON_ROTATE_LEFT],
    ["KeyE", controls.BUTTON_ROTATE_RIGHT],
    ["KeyR", controls.BUTTON_RESET],
    ["KeyI", controls.BUTTON_INVENTORY],
    ["KeyC", controls.BUTTON_CHARACTER],
    ["KeyK", controls.BUTTON_SKILLS],
    ["KeyQ", controls.BUTTON_QUEST],
    ["Tab", controls.BUTTON_MAP],
    ["Digit1", controls.BUTTON_POTION_1],
    ["Digit2", controls.BUTTON_POTION_2],
    ["Digit3", controls.BUTTON_POTION_3],
    ["Digit4", controls.BUTTON_POTION_4],
    ["ShiftLeft", controls.BUTTON_SHIFT],
    ["ShiftRight", controls.BUTTON_SHIFT],
    ["Escape", controls.BUTTON_ESCAPE],
  ]) {
    if (keys.has(key)) {
      buttons |= mask;
    }
  }
  if (keys.has("ArrowLeft") || keys.has("KeyA")) {
    buttons |= 1;
  }
  if (keys.has("ArrowRight") || keys.has("KeyD")) {
    buttons |= 2;
  }
  if (keys.has("ArrowUp") || keys.has("KeyW")) {
    buttons |= 4;
  }
  if (keys.has("ArrowDown") || keys.has("KeyS")) {
    buttons |= 8;
  }
  if (keys.has("Space")) {
    buttons |= 16;
  }
  const pad = [...(navigator.getGamepads?.() || [])].find(
    (pad) => pad?.connected && pad.mapping === "standard",
  );
  if (pad) {
    if (pad.buttons[14]?.pressed) {
      buttons |= 1 | controls.BUTTON_MOVE_LEFT;
    }
    if (pad.buttons[15]?.pressed) {
      buttons |= 2 | controls.BUTTON_MOVE_RIGHT;
    }
    if (pad.buttons[12]?.pressed) {
      buttons |= 4 | controls.BUTTON_MOVE_UP;
    }
    if (pad.buttons[13]?.pressed) {
      buttons |= 8 | controls.BUTTON_MOVE_DOWN;
    }
    if (pad.buttons[0]?.pressed) {
      buttons |= 16;
    }
  }
  const hover =
    pointer.hover &&
    pointer.x >= 0 &&
    pointer.x < (globalThis.playerStatus.width || canvas.width) &&
    pointer.y >= 0 &&
    pointer.y < (globalThis.playerStatus.height || canvas.height);
  if (hover) {
    buttons |= controls.BUTTON_POINTER_HOVER;
    if (pointer.pointer) {
      buttons |= controls.BUTTON_POINTER_LEFT;
    }
    if (pointer.right) {
      buttons |= controls.BUTTON_POINTER_RIGHT;
    }
  }
  if (wheelDirection > 0) {
    buttons |= controls.BUTTON_WHEEL_UP;
  }
  if (wheelDirection < 0) {
    buttons |= controls.BUTTON_WHEEL_DOWN;
  }
  if (consumeWheel) {
    wheelDirection = 0;
  }
  return {
    buttons: buttons >>> 0,
    pointer: pointer.pointer && hover,
    x: pointer.x,
    y: pointer.y,
  };
}

window.addEventListener("keydown", (event) => {
  if (document.activeElement !== canvas) {
    return;
  }
  if (
    [
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Space",
      "KeyW",
      "KeyA",
      "KeyS",
      "KeyD",
      "KeyQ",
      "KeyE",
      "KeyR",
      "KeyI",
      "KeyC",
      "KeyK",
      "Tab",
      "Digit1",
      "Digit2",
      "Digit3",
      "Digit4",
      "ShiftLeft",
      "ShiftRight",
      "Escape",
    ].includes(event.code)
  ) {
    event.preventDefault();
    keys.add(event.code);
  }
});
window.addEventListener("keyup", (event) => keys.delete(event.code));
function point(event) {
  const rect = canvas.getBoundingClientRect();
  pointer.x =
    ((event.clientX - rect.left) * (globalThis.playerStatus.width || canvas.width)) / rect.width;
  pointer.y =
    ((event.clientY - rect.top) * (globalThis.playerStatus.height || canvas.height)) / rect.height;
  pointer.hover = true;
  pointer.pointer = (event.buttons & 1) !== 0;
  pointer.right = (event.buttons & 2) !== 0;
}
canvas.addEventListener("pointerdown", (event) => {
  canvas.focus();
  canvas.setPointerCapture(event.pointerId);
  point(event);
});
canvas.addEventListener("pointermove", point);
canvas.addEventListener("pointerenter", point);
canvas.addEventListener("pointerup", point);
canvas.addEventListener("pointerleave", () => {
  pointer.hover = false;
});
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener(
  "wheel",
  (event) => {
    if (document.activeElement !== canvas) {
      return;
    }
    event.preventDefault();
    if (event.deltaY !== 0) {
      wheelDirection = -Math.sign(event.deltaY);
    }
  },
  { passive: false },
);
for (const name of ["pointercancel", "lostpointercapture"]) {
  canvas.addEventListener(name, () => {
    pointer.pointer = false;
    pointer.right = false;
    if (name === "pointercancel") {
      pointer.hover = false;
    }
  });
}
button.addEventListener("click", () => start().catch((error) => fail(error.message)));
function resize() {
  const full = document.fullscreenElement === document.getElementById("screen");
  const density = devicePixelRatio || 1;
  const width = globalThis.playerStatus.width || 640,
    height = globalThis.playerStatus.height || 360;
  const available = Math.min(
    ((innerWidth - (full ? 0 : 32)) * density) / width,
    ((innerHeight - (full ? 0 : 150)) * density) / height,
  );
  const scale = available >= 1 ? Math.floor(available) : Math.max(0.25, available);
  canvas.style.width = `${(width * scale) / density}px`;
  canvas.style.height = `${(height * scale) / density}px`;
}
function displayPixels() {
  const full = document.fullscreenElement === document.getElementById("screen");
  return [
    Math.max(1, Math.floor((innerWidth - (full ? 0 : 32)) * (devicePixelRatio || 1))),
    Math.max(1, Math.floor((innerHeight - (full ? 0 : 150)) * (devicePixelRatio || 1))),
  ];
}
document.getElementById("fullscreen").addEventListener("click", () =>
  document
    .getElementById("screen")
    .requestFullscreen()
    .catch((error) => {
      status.textContent = error.message;
    }),
);
document.addEventListener("fullscreenchange", resize);
canvas.addEventListener("contextlost", (event) => {
  event.preventDefault();
  fail("Display context lost. Restore the display and restart the game.");
});
window.addEventListener("resize", resize);
resize();
if (graphicsError || timingError) {
  fail(graphicsError || timingError);
} else {
  load().catch((error) => fail(error.message));
}
