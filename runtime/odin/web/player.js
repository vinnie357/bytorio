import { PREVIEW_SAMPLE_RATE, resourceSchema as audioLimits } from "./constants.js";
import { PLAYER_TITLE } from "./constants.js";
import { prepareExecutor } from "./executor-cache.js";
import { normalizeGraphics } from "./gpu.js";
import * as controls from "./constants.js";
import { FrameClock, parseFrameRate } from "./frame-clock.js";
import { gamepadButtons } from "./gamepad.js";
import {
  installTouchControls,
  touchButtons,
  touchLayout,
  touchScale,
  touchShown,
} from "./touch.js";
import { createTextInputOverlay } from "./text-input.js";
const canvas = document.getElementById("canvas");
const display = canvas.getContext("2d", { alpha: false });
const button = document.getElementById("start");
const status = document.getElementById("status");
const parameters = new URLSearchParams(location.search);
if (document.title === "Game player") {
  document.title = PLAYER_TITLE;
}
const smoke = parameters.has("smoke");
let clock = new FrameClock();
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
  clock.nextDraw = clock.elapsed;
  const url = new URL(location.href);
  url.searchParams.set("fps", String(frameRateSetting()));
  history.replaceState(null, "", url);
  globalThis.playerStatus.renderFps = frameRateSetting();
}
frameRateControl.addEventListener("change", changeFrameRate);
frameRateCap.addEventListener("change", changeFrameRate);
let statsStarted = performance.now();
let statsFrames = 0;
let statsUploads = 0;
let frameTimer;
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
  load(started).catch((error) => fail(error.message));
});
const keys = new Set();
const pointer = { pointer: false, hover: false, right: false, x: 0, y: 0 };
let wheelDirection = 0;
let worker,
  watchdog,
  pending = false,
  started = false,
  autoStart = false;
let selectedCartridge = null;
let startRequest = 0;
let mixerNode = null;
let mixerLoading = null;
let mixerGeneration = 0;
const mixerPackets = [];
const textInput = createTextInputOverlay({
  canvas,
  logicalSize: () => [
    globalThis.playerStatus.width || canvas.width,
    globalThis.playerStatus.height || canvas.height,
  ],
  send: (update) => worker?.postMessage({ type: "text-input", update }),
  onEditing: (active) => {
    if (!active) {
      return;
    }
    keys.clear();
    pointer.pointer = pointer.right = pointer.hover = false;
    wheelDirection = 0;
  },
});

async function ensureMixer() {
  if (mixerNode || !globalThis.playerAudio.lowEnabled) {
    return;
  }
  if (mixerLoading) {
    return mixerLoading;
  }
  const current = generation;
  mixerLoading = (async () => {
    const context = globalThis.playerAudio.context;
    await context.audioWorklet.addModule("./audio-worklet.js");
    const response = await fetch("./audio.wasm");
    if (!response.ok) {
      throw new Error("Cannot load shared audio mixer.");
    }
    const module = await WebAssembly.compile(await response.arrayBuffer());
    if (current !== generation || !worker || !globalThis.playerStatus.ready) {
      return;
    }
    const node = new AudioWorkletNode(context, "console-pcm-mixer", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { module, waitForProducer: true },
    });
    mixerNode = node;
    mixerGeneration = current;
    const channel = new MessageChannel();
    node.port.postMessage({ type: "worker-port", port: channel.port1 }, [channel.port1]);
    worker.postMessage({ type: "audio-connect", port: channel.port2 }, [channel.port2]);
    node.port.onmessage = ({ data }) => {
      if (data.type === "closed") {
        node.port.close();
        return;
      }
      if (current !== generation) {
        return;
      }
      if (data.type === "error") {
        fail(data.error);
      } else if (data.type === "recycle") {
        worker.postMessage({ type: "audio-recycle", id: data.id, buffer: data.buffer }, [
          data.buffer,
        ]);
      } else if (data.type === "feedback") {
        const view = new DataView(data.buffer, 0, data.bytes);
        const wide = (at) => view.getUint32(at, true) + view.getUint32(at + 4, true) * 2 ** 32;
        globalThis.playerAudio.mixerStatus = {
          frame: wide(16),
          epoch: view.getUint32(12, true),
          lateEvents: wide(32),
          underrunFrames: wide(40),
          rejectedWrites: wide(48),
          completed: wide(56),
          deviceRate: context.sampleRate,
          leadFrames: audioLimits.audioLeadFrames,
          baseLatency: context.baseLatency,
          outputLatency: context.outputLatency ?? null,
        };
        worker.postMessage(
          { type: "audio-feedback", id: data.id, buffer: data.buffer, bytes: data.bytes },
          [data.buffer],
        );
      }
    };
    node.onprocessorerror = () => {
      if (current === generation && mixerNode === node) {
        fail("AudioWorklet mixer failed.");
      }
    };
    for (const packet of mixerPackets.splice(0)) {
      node.port.postMessage({ ...packet, type: "packet" }, [packet.buffer]);
    }
    node.connect(context.destination);
  })();
  try {
    await mixerLoading;
  } finally {
    mixerLoading = null;
  }
}

function closeMixer() {
  mixerGeneration = 0;
  if (mixerNode) {
    mixerNode.port.postMessage({ type: "close" });
    mixerNode.disconnect();
    mixerNode = null;
  }
  mixerPackets.length = 0;
  globalThis.playerAudio.lowEnabled = false;
  globalThis.playerAudio.mixerStatus = null;
}
let selection = 0;
let previous = performance.now(),
  generation = 0,
  soundsPlayed = 0;
globalThis.playerStatus = { ready: false, error: "", ticks: 0 };

globalThis.playerAudio = {
  context: null,
  buffer: null,
  played: 0,
  ended: 0,
  peak: 0,
  source: null,
  play() {
    if (!this.buffer || this.context?.state !== "running") {
      return;
    }
    if (this.source) {
      this.source.onended = null;
      this.source.stop();
    }
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.context.destination);
    source.onended = () => {
      this.ended++;
      if (this.source === source) {
        this.source = null;
      }
    };
    source.start();
    this.source = source;
    this.played++;
  },
};

function stopOutput() {
  startRequest++;
  keys.clear();
  pointer.pointer = false;
  pointer.right = false;
  pointer.hover = false;
  wheelDirection = 0;
  const audio = globalThis.playerAudio;
  if (audio.source) {
    audio.source.onended = null;
    audio.source.stop();
    audio.source = null;
  }
}

function fail(message) {
  textInput.close();
  clearTimeout(watchdog);
  worker?.terminate();
  stopOutput();
  closeMixer();
  worker = null;
  pending = started = false;
  globalThis.playerStatus = { ...globalThis.playerStatus, ready: false, error: message };
  status.textContent = message;
  button.textContent = "Restart game";
  button.disabled = false;
}

function armWatchdog(delay) {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => fail("Game stopped responding. Restart to try again."), delay);
}

function maybePlay() {
  if (started && globalThis.playerStatus.sounds !== soundsPlayed) {
    globalThis.playerAudio.play();
    soundsPlayed = globalThis.playerStatus.sounds;
  }
}

async function start() {
  const request = ++startRequest;
  const audio = globalThis.playerAudio;
  if (!audio.context) {
    audio.context = new AudioContext();
  }
  await audio.context.resume();
  if (audio.context.state !== "running") {
    throw new Error("Audio could not start. Try again.");
  }
  if (globalThis.playerStatus.error) {
    load(true);
    return;
  }
  if (!globalThis.playerStatus.ready) {
    return;
  }
  if (!audio.buffer) {
    audio.buffer = audio.context.createBuffer(1, audio.samples.length, PREVIEW_SAMPLE_RATE);
    audio.buffer.copyToChannel(audio.samples, 0);
  }
  await ensureMixer();
  // No simulation may produce audio commands until its consumer exists. A
  // blur, reload or failure while loading also cancels this start request.
  if (request !== startRequest || !globalThis.playerStatus.ready) {
    return;
  }
  started = true;
  mixerNode?.port.postMessage({ type: "pause", paused: false });
  previous = performance.now();
  clock = new FrameClock();
  button.textContent = "Resume game";
  canvas.focus();
  maybePlay();
}

async function load(restart = false) {
  if (parameters.has("local") && !selectedCartridge) {
    status.textContent = "Choose a PNG cartridge from your device to begin.";
    button.disabled = true;
    return;
  }
  if (!display || display.isContextLost?.()) {
    fail("Display context unavailable. Restore the display and restart the game.");
    return;
  }
  const currentGeneration = ++generation;
  textInput.close();
  worker?.terminate();
  stopOutput();
  closeMixer();
  pending = started = false;
  autoStart = restart;
  let loading = true;
  soundsPlayed = 0;
  globalThis.playerAudio.buffer = null;
  globalThis.playerStatus = { ready: false, error: "", ticks: 0 };
  status.textContent = `Loading ${PLAYER_TITLE}…`;
  button.disabled = true;
  worker = new Worker("./worker.js", { type: "module" });
  armWatchdog(10000);
  worker.onerror = (event) => {
    event.preventDefault();
    if (currentGeneration === generation) {
      fail(event.message || "Player worker failed.");
    }
  };
  worker.onmessage = ({ data }) => {
    if (currentGeneration !== generation) {
      return;
    }
    if (data.type === "text-state") {
      textInput.configure(data.state);
      return;
    }
    if (data.type === "loading" && loading) {
      armWatchdog(10000);
      const downloaded = `${mib(data.received)} MiB`;
      const total = data.total ? ` / ${mib(data.total)} MiB` : "";
      status.textContent = `Loading ${PLAYER_TITLE}… ${downloaded}${total}`;
      return;
    }
    if (data.type === "audio-status") {
      const context = globalThis.playerAudio.context;
      globalThis.playerAudio.mixerStatus = {
        ...data.status,
        deviceRate: context?.sampleRate,
        leadFrames: audioLimits.audioLeadFrames,
        baseLatency: context?.baseLatency,
        outputLatency: context?.outputLatency ?? null,
      };
      return;
    }
    if (data.type === "audio-packet") {
      if (mixerNode && mixerGeneration === generation) {
        mixerNode.port.postMessage({ ...data, type: "packet" }, [data.buffer]);
      } else {
        if (mixerPackets.length >= audioLimits.maxAudioTransfers) {
          fail("Initial audio schedule exceeds transfer credits.");
          return;
        }
        mixerPackets.push(data);
      }
      return;
    }
    if (data.type === "audio-feedback-recycle") {
      mixerNode?.port.postMessage({ type: "feedback-recycle", id: data.id, buffer: data.buffer }, [
        data.buffer,
      ]);
      return;
    }
    if (data.type === "executor") {
      armWatchdog(10000);
      prepareExecutor("./luau-executor.wasm")
        .then((executor) => {
          if (currentGeneration === generation) {
            worker.postMessage({ type: "executor", executor });
          }
        })
        .catch((error) => {
          if (currentGeneration === generation) {
            fail(error.message);
          }
        });
      return;
    }
    if (data.type === "executing") {
      loading = false;
      armWatchdog(1000);
      return;
    }
    clearTimeout(watchdog);
    pending = false;
    if (data.type === "error") {
      fail(data.error);
      return;
    }
    if (data.type === "stepped") {
      globalThis.playerStatus.ticks = data.ticks;
      if (data.audioEnabled) {
        globalThis.playerAudio.lowEnabled = true;
        if (started) {
          ensureMixer().catch((error) => fail(error.message));
        }
      }
      requestFrame(performance.now());
      return;
    }
    if (data.type === "ready") {
      loading = false;
      if (data.title) {
        document.title = data.title;
      }
      const audio = globalThis.playerAudio;
      audio.samples = new Float32Array(data.sample);
      audio.peak = audio.samples.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);
      button.disabled = false;
      button.textContent = "Start game";
    }
    if (data.type !== "ready" && data.type !== "frame") {
      fail("Invalid player response.");
      return;
    }
    if (data.audioEnabled) {
      globalThis.playerAudio.lowEnabled = true;
      if (started) {
        ensureMixer().catch((error) => fail(error.message));
      }
    }
    const imageWidth = data.presentationWidth || data.width,
      imageHeight = data.presentationHeight || data.height;
    if (canvas.width !== imageWidth || canvas.height !== imageHeight) {
      canvas.width = imageWidth;
      canvas.height = imageHeight;
      resize();
    }
    if (data.bitmap) {
      display.drawImage(data.bitmap, 0, 0);
      data.bitmap.close();
    } else {
      display.putImageData(
        new ImageData(new Uint8ClampedArray(data.pixels), imageWidth, imageHeight),
        0,
        0,
      );
    }
    const { ticks, sounds, spriteX, spriteY, x, y, hash, width, height } = data;
    if (data.metrics) {
      const now = performance.now();
      statsFrames++;
      statsUploads += data.metrics.gpuUploadBytes;
      const elapsed = now - statsStarted;
      if (elapsed >= 500 || data.type === "ready") {
        const m = data.metrics;
        document.getElementById("performance").textContent =
          `${started && elapsed >= 500 ? ((statsFrames * 1000) / elapsed).toFixed(1) : "—"} FPS delivered · render ${m.renderMs.toFixed(1)} ms\n` +
          `GPU uploads ${mib((statsUploads * 1000) / Math.max(1, elapsed))} MiB/s · mesh uploads ${m.meshUploads}\n` +
          `GPU meshes ${mib(m.gpuCacheBytes)} MiB · textures ${mib(m.gpuTextureBytes)} MiB (est.)\n` +
          `GPU snapshots ${mib(m.gpuFrameBytes)} MiB (included above) · read back ${mib(m.gpuSnapshotReadbackBytes)} MiB total\n` +
          `Wasm guest ${mib(m.memory.currentLinear)} MiB · runtime ${mib(m.memory.runtimeLinear)} MiB\n` +
          `Resources ${mib(m.resourceBytes)} MiB · CPU quality ${mib(m.cpuQualityBytes)} MiB (overlaps runtime)`;
        statsStarted = now;
        statsFrames = 0;
        statsUploads = 0;
      }
    }
    globalThis.playerStatus = {
      ...globalThis.playerStatus,
      ready: true,
      error: "",
      ticks,
      sounds,
      spriteX,
      spriteY,
      x,
      y,
      hash,
      width,
      height,
      smoothPresentation: data.smoothPresentation,
      presentationWidth: imageWidth,
      presentationHeight: imageHeight,
      metrics: data.metrics,
      renderFps: frameRateSetting(),
      simulationHz: 60,
      frames: (globalThis.playerStatus.frames || 0) + 1,
    };
    resize();
    if (data.startup) {
      globalThis.playerStatus.startup = data.startup;
    }
    if (data.graphics) {
      globalThis.playerStatus.graphics = data.graphics;
      document.getElementById("graphics-status").textContent =
        `Active renderer: ${data.graphics.effective}${data.graphics.fallback ? ` · ${data.graphics.fallback}` : ""}`;
    }
    if (graphics.smoothPan && !data.smoothPresentation) {
      document.getElementById("graphics-status").textContent =
        "Smooth pan inactive: needs an enlarged single orthographic screen batch with opaque HUD draws.";
    }
    if (data.memory) {
      globalThis.playerStatus.memory = data.memory;
    }
    status.textContent = help();
    maybePlay();
    if (autoStart) {
      autoStart = false;
      start().catch((error) => fail(error.message));
    }
    requestFrame(performance.now());
  };
  try {
    const gameUrl = parameters.get("game") || globalThis.playerCartridge || "./game.wasm";
    const executor =
      !selectedCartridge && new URL(gameUrl, location.href).pathname.endsWith(".luau")
        ? await prepareExecutor("./luau-executor.wasm")
        : null;
    if (currentGeneration !== generation) {
      return;
    }
    worker.postMessage({
      type: "load",
      gameUrl,
      progress: true,
      smoke,
      executor,
      cartridge: selectedCartridge,
      graphics,
      presentationSize: displayPixels(),
    });
  } catch (error) {
    if (currentGeneration === generation) {
      fail(error.message || String(error));
    }
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
  if (textInput.editing()) {
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
  buttons |= gamepadButtons();
  buttons |= touchButtons();
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

function requestFrame(now = performance.now(), displayOpportunity = false) {
  clearTimeout(frameTimer);
  frameTimer = undefined;
  // A response can arrive after the timestamp of an already queued RAF.
  const current = Math.max(now, previous);
  const delta = Math.min((current - previous) / 1000, 0.1);
  previous = current;
  if (started && worker && !document.hidden && !(smoke && globalThis.playerStatus.ticks >= 120)) {
    clock.advance(delta);
    // Bundle updates with the display callback in native mode. A tick timer
    // competing with RAF could otherwise occupy the Worker at every refresh.
    if (!smoke && renderFps === 0 && !displayOpportunity) {
      return;
    }
    if (!pending) {
      const { steps, render } = smoke
        ? { steps: 1, render: true }
        : clock.take(renderFps, displayOpportunity);
      if (steps === 0 && !render) {
        frameTimer = setTimeout(requestFrame, clock.delay(renderFps));
        return;
      }
      pending = true;
      armWatchdog(1000);
      worker.postMessage({
        type: "step",
        diagnostics: false,
        steps,
        render,
        input: input(steps > 0),
        presentationSize: displayPixels(),
      });
    }
  }
}
function animate(now) {
  requestFrame(now, true);
  requestAnimationFrame(animate);
}

function resetInput() {
  startRequest++;
  clearTimeout(frameTimer);
  frameTimer = undefined;
  keys.clear();
  pointer.pointer = false;
  pointer.right = false;
  pointer.hover = false;
  wheelDirection = 0;
  clock = new FrameClock();
}
window.addEventListener("blur", () => {
  resetInput();
  started = false;
  mixerNode?.port.postMessage({ type: "pause", paused: true });
});
document.addEventListener("visibilitychange", () => {
  resetInput();
  previous = performance.now();
  if (document.hidden) {
    started = false;
    mixerNode?.port.postMessage({ type: "pause", paused: true });
  }
});
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
// What the page leaves free around the canvas: the touch controls' columns or panel while they are
// up, otherwise room for the page's own controls (none in fullscreen).
function reserved() {
  const full = document.fullscreenElement === document.getElementById("screen");
  const width = globalThis.playerStatus.width || 640,
    height = globalThis.playerStatus.height || 360;
  return (
    touchLayout({ width, height }) ?? (full ? { width: 0, height: 0 } : { width: 32, height: 150 })
  );
}
// The page's own help line: a game's `playerInstructions` win, otherwise the keyboard wording, or
// the touch wording once the touch controls are up.
const KEYBOARD_HELP = "Arrows / WASD: move · Space / tap: sound";
const TOUCH_HELP = "D-pad: move · A: action · B: back · START: map · L / R: rotate";
function help() {
  return globalThis.playerInstructions || (touchShown() ? TOUCH_HELP : KEYBOARD_HELP);
}
function resize() {
  const reserve = reserved();
  const density = devicePixelRatio || 1;
  const width = globalThis.playerStatus.width || 640,
    height = globalThis.playerStatus.height || 360;
  const available = Math.min(
    ((innerWidth - reserve.width) * density) / width,
    ((innerHeight - reserve.height) * density) / height,
  );
  // Desktop keeps whole device pixels; the touch layout falls back to an exact fit when they would
  // leave a phone's screen mostly empty.
  const scale = touchShown()
    ? touchScale(available)
    : available >= 1
      ? Math.floor(available)
      : Math.max(0.25, available);
  canvas.style.width = `${(width * scale) / density}px`;
  canvas.style.height = `${(height * scale) / density}px`;
  textInput.reposition();
}
function displayPixels() {
  const reserve = reserved();
  return [
    Math.max(1, Math.floor((innerWidth - reserve.width) * (devicePixelRatio || 1))),
    Math.max(1, Math.floor((innerHeight - reserve.height) * (devicePixelRatio || 1))),
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
installTouchControls({
  parent: document.getElementById("screen"),
  // A lifted touch starts or resumes the player exactly as the Start button does, so a landscape
  // phone that cannot reach that button still plays.
  onActivate: () => {
    if (!started && !button.disabled) {
      start().catch((error) => fail(error.message));
    }
  },
  onFullscreen: () => document.getElementById("fullscreen").click(),
  onLayout: () => {
    resize();
    if ([KEYBOARD_HELP, TOUCH_HELP].includes(status.textContent)) {
      status.textContent = help();
    }
  },
});
resize();
if (graphicsError || timingError) {
  fail(graphicsError || timingError);
} else {
  load();
}
requestAnimationFrame(animate);
