import { createRuntime } from "./runtime.js";

const canvas = document.querySelector("#game");
const status = document.querySelector("#status");
const play = document.querySelector("#play");
const action = document.querySelector("#action");
const mute = document.querySelector("#mute");
const restart = document.querySelector("#restart");
const open = document.querySelector("#open");
const file = document.querySelector("#file");
const stop = document.querySelector("#dispose");
const listeners = new AbortController();
const keys = new Set();
const bindings = {
  ArrowLeft: "left",
  KeyA: "left",
  ArrowRight: "right",
  KeyD: "right",
  ArrowUp: "up",
  KeyW: "up",
  ArrowDown: "down",
  KeyS: "down",
  Space: "action",
};
let pointerId = null;
let disposed = false;

export const runtime = createRuntime({ canvas });

function listen(target, type, handler) {
  target.addEventListener(type, handler, { signal: listeners.signal });
}

function releasePointer() {
  if (pointerId !== null && canvas.hasPointerCapture(pointerId)) {
    canvas.releasePointerCapture(pointerId);
  }
  pointerId = null;
  if (!disposed) {
    runtime.setInput("pointer", null);
  }
}

function release() {
  keys.clear();
  releasePointer();
  if (!disposed) {
    runtime.clearInput();
  }
}

function render(snapshot) {
  const playing = snapshot.state === "running";
  play.textContent = playing ? "Pause" : "Play";
  play.disabled = !snapshot.ready;
  action.disabled = !playing;
  restart.disabled = !snapshot.ready;
  mute.textContent = snapshot.audio.muted ? "Unmute" : "Mute";
  mute.setAttribute("aria-pressed", String(snapshot.audio.muted));
  status.textContent = snapshot.error || snapshot.state;
  if (!playing || snapshot.textEditing) {
    release();
  }
}

async function perform(operation) {
  if (disposed) {
    return;
  }
  try {
    await operation();
  } catch (error) {
    if (!disposed && error.name !== "AbortError") {
      status.textContent = error.message;
    }
  }
}

runtime.on("state", render);
runtime.on("error", render);
runtime.on("audio", render);
listen(play, "click", () =>
  perform(async () => {
    if (runtime.state === "running") {
      release();
      runtime.pause();
    } else {
      await runtime.play();
      if (!disposed) {
        canvas.focus();
      }
    }
  }),
);
listen(action, "click", () => runtime.pulseInput(["action"]));
listen(mute, "click", () => runtime.setMuted(!runtime.getSnapshot().audio.muted));
listen(restart, "click", () =>
  perform(async () => {
    release();
    await runtime.restart();
  }),
);
listen(open, "click", () => file.click());
listen(file, "change", () => {
  const cartridge = file.files[0];
  file.value = "";
  if (cartridge) {
    void perform(async () => {
      release();
      await runtime.load(cartridge);
    });
  }
});

function acceptsInput() {
  return !disposed && runtime.state === "running" && !runtime.getSnapshot().textEditing;
}

listen(canvas, "keydown", (event) => {
  const binding = bindings[event.code];
  if (!binding || !acceptsInput() || event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }
  event.preventDefault();
  // Discrete actions survive even a down/up pair between simulation updates.
  if (binding === "action") {
    if (!event.repeat) {
      runtime.pulseInput([binding]);
    }
  } else {
    keys.add(event.code);
    runtime.setInput("keyboard", { buttons: [...keys].map((key) => bindings[key]) });
  }
});
listen(window, "keyup", (event) => {
  if (keys.delete(event.code)) {
    runtime.setInput("keyboard", { buttons: [...keys].map((key) => bindings[key]) });
  }
});
listen(canvas, "blur", release);

function point(event) {
  const rect = canvas.getBoundingClientRect();
  const { width, height } = runtime.getSnapshot();
  runtime.setInput("pointer", {
    pointer: {
      x: ((event.clientX - rect.left) * width) / rect.width,
      y: ((event.clientY - rect.top) * height) / rect.height,
      down: pointerId === event.pointerId && (event.buttons & 1) !== 0,
      right: pointerId === event.pointerId && (event.buttons & 2) !== 0,
    },
  });
}

listen(canvas, "pointerdown", (event) => {
  if (!acceptsInput() || pointerId !== null || ![0, 2].includes(event.button)) {
    return;
  }
  event.preventDefault();
  canvas.focus();
  pointerId = event.pointerId;
  canvas.setPointerCapture(pointerId);
  point(event);
});
listen(canvas, "pointermove", (event) => {
  if (acceptsInput() && (pointerId === null || pointerId === event.pointerId)) {
    point(event);
  }
});
listen(canvas, "pointerup", (event) => {
  if (event.pointerId === pointerId) {
    releasePointer();
  }
});
listen(canvas, "pointercancel", (event) => {
  if (event.pointerId === pointerId) {
    releasePointer();
  }
});
listen(canvas, "lostpointercapture", (event) => {
  if (event.pointerId === pointerId) {
    releasePointer();
  }
});
listen(canvas, "pointerleave", () => {
  if (pointerId === null && !disposed) {
    runtime.setInput("pointer", null);
  }
});
listen(canvas, "contextmenu", (event) => event.preventDefault());

// SPA hosts should await this before removing or reusing the canvas.
export async function dispose() {
  if (!disposed) {
    release();
    disposed = true;
    listeners.abort();
    for (const button of [play, action, mute, restart, open, stop]) {
      button.disabled = true;
    }
  }
  await runtime.dispose();
  status.textContent = "disposed";
}

listen(
  stop,
  "click",
  () =>
    void dispose().catch((error) => {
      status.textContent = error.message;
    }),
);
listen(window, "pagehide", () => void dispose().catch(() => {}));
export const ready = perform(() => runtime.load("./game.png"));
