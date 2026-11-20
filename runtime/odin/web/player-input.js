import { buttons, buttonMask } from "./runtime.js";

const keyboard = {
  ArrowLeft: ["left", "pan_left"],
  ArrowRight: ["right", "pan_right"],
  ArrowUp: ["up", "pan_up"],
  ArrowDown: ["down", "pan_down"],
  KeyA: ["left", "move_left"],
  KeyD: ["right", "move_right"],
  KeyW: ["up", "move_up"],
  KeyS: ["down", "move_down"],
  Space: ["action"],
  KeyQ: ["rotate_left", "quest"],
  KeyE: ["rotate_right"],
  KeyR: ["reset"],
  KeyI: ["inventory"],
  KeyC: ["character"],
  KeyK: ["skills"],
  KeyM: ["map"],
  Digit1: ["potion_1"],
  Digit2: ["potion_2"],
  Digit3: ["potion_3"],
  Digit4: ["potion_4"],
  ShiftLeft: ["shift"],
  ShiftRight: ["shift"],
  Escape: ["escape"],
};
const keyMasks = Object.fromEntries(
  Object.entries(keyboard).map(([key, value]) => [key, buttonMask(value)]),
);

export function attachPlayerInput({ runtime, canvas, controls, config }) {
  const scope = canvas.ownerDocument.defaultView;
  const abort = new AbortController();
  const signal = abort.signal;
  const heldKeys = new Set();
  const heldControls = new Map();
  const pointers = new Set();
  const active = () =>
    canvas.getRootNode().activeElement === canvas &&
    runtime.state === "running" &&
    !runtime.getSnapshot().textEditing;
  const listen = (element, name, listener, options = {}) =>
    element.addEventListener(name, listener, { ...options, signal });
  function updateKeys() {
    let mask = 0;
    for (const key of heldKeys) {
      mask |= keyMasks[key];
    }
    runtime.setInput("keyboard", { buttons: mask >>> 0 });
  }
  listen(canvas, "keydown", (event) => {
    if (
      !config.keyboard ||
      !active() ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      !Object.hasOwn(keyMasks, event.code)
    ) {
      return;
    }
    event.preventDefault();
    heldKeys.add(event.code);
    updateKeys();
  });
  listen(scope, "keyup", (event) => {
    if (heldKeys.delete(event.code)) {
      updateKeys();
    }
  });
  listen(canvas, "blur", () => {
    heldKeys.clear();
    runtime.setInput("keyboard", null);
    runtime.setInput("gamepad", null);
  });
  function pointer(event) {
    if (!config.pointer || runtime.state !== "running" || runtime.getSnapshot().textEditing) {
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) {
      return;
    }
    const state = runtime.getSnapshot();
    runtime.setInput(`pointer:${event.pointerId}`, {
      pointer: {
        x: ((event.clientX - bounds.left) * state.width) / bounds.width,
        y: ((event.clientY - bounds.top) * state.height) / bounds.height,
        down: !!(event.buttons & 1),
        right: !!(event.buttons & 2),
        hover: true,
      },
    });
    pointers.add(event.pointerId);
  }
  listen(canvas, "pointerdown", (event) => {
    if (runtime.state !== "running" || runtime.getSnapshot().textEditing) {
      return;
    }
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    pointer(event);
  });
  listen(canvas, "pointermove", pointer);
  listen(canvas, "pointerenter", pointer);
  function releasePointer(event) {
    runtime.setInput(`pointer:${event.pointerId}`, null);
    pointers.delete(event.pointerId);
  }
  for (const name of ["pointercancel", "lostpointercapture", "pointerleave"]) {
    listen(canvas, name, (event) => {
      if (name !== "pointerleave" || !canvas.hasPointerCapture(event.pointerId)) {
        releasePointer(event);
      }
    });
  }
  listen(canvas, "pointerup", (event) => {
    if (event.pointerType === "mouse") {
      pointer(event);
    } else {
      releasePointer(event);
    }
  });
  listen(canvas, "contextmenu", (event) => event.preventDefault());
  listen(
    canvas,
    "wheel",
    (event) => {
      if (active() && event.deltaY) {
        event.preventDefault();
        runtime.pulseInput([event.deltaY < 0 ? "wheel_up" : "wheel_down"]);
      }
    },
    { passive: false },
  );
  function releaseControl(pointerId) {
    const control = heldControls.get(pointerId);
    if (!control) {
      return;
    }
    heldControls.delete(pointerId);
    runtime.setInput(`control:${pointerId}`, null);
    const pressed = [...heldControls.values()].some((value) => value === control);
    control.classList.toggle("pressed", pressed);
    control.setAttribute("aria-pressed", String(pressed));
  }
  for (const item of config.layout) {
    const control = controls.querySelector(`[data-control="${item.id}"]`);
    listen(control, "pointerdown", (event) => {
      event.preventDefault();
      if (runtime.state !== "running" || runtime.getSnapshot().textEditing) {
        return;
      }
      canvas.focus({ preventScroll: true });
      control.setPointerCapture(event.pointerId);
      heldControls.set(event.pointerId, control);
      runtime.setInput(`control:${event.pointerId}`, { buttons: item.bindings });
      control.classList.add("pressed");
      control.setAttribute("aria-pressed", "true");
    });
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
      listen(control, name, (event) => releaseControl(event.pointerId));
    }
    listen(control, "contextmenu", (event) => event.preventDefault());
    listen(control, "click", (event) => {
      if (event.detail === 0 && runtime.state === "running" && !runtime.getSnapshot().textEditing) {
        runtime.pulseInput(item.bindings);
      }
    });
  }
  function reset() {
    heldKeys.clear();
    for (const id of [...heldControls.keys()]) {
      releaseControl(id);
    }
    for (const id of pointers) {
      runtime.setInput(`pointer:${id}`, null);
    }
    pointers.clear();
    runtime.setInput("keyboard", null);
    runtime.setInput("gamepad", null);
  }
  const unsubscribe = runtime.on("state", (state) => {
    if (state.state === "disposed") {
      return;
    }
    if (state.state !== "running" || state.textEditing) {
      reset();
    }
  });
  const unsubscribeError = runtime.on("error", reset);
  const media = scope.matchMedia("(any-pointer: coarse)");
  function visibility() {
    controls.hidden =
      !config.layout.length ||
      config.visibility === "never" ||
      (config.visibility === "auto" && !media.matches && !scope.navigator.maxTouchPoints);
    reset();
  }
  listen(media, "change", visibility);
  visibility();
  let animation;
  function poll() {
    if (config.gamepad && active()) {
      const pad = [...(scope.navigator.getGamepads?.() || [])].find(
        (pad) => pad?.connected && pad.mapping === "standard",
      );
      let mask = 0;
      if (pad) {
        for (const [index, binding] of [
          [14, buttons.left | buttons.move_left],
          [15, buttons.right | buttons.move_right],
          [12, buttons.up | buttons.move_up],
          [13, buttons.down | buttons.move_down],
          [0, buttons.action],
        ]) {
          if (pad.buttons[index]?.pressed) {
            mask |= binding;
          }
        }
      }
      runtime.setInput("gamepad", { buttons: mask >>> 0 });
    }
    animation = scope.requestAnimationFrame(poll);
  }
  animation = scope.requestAnimationFrame(poll);
  return () => {
    unsubscribe();
    unsubscribeError();
    abort.abort();
    scope.cancelAnimationFrame(animation);
    reset();
  };
}
