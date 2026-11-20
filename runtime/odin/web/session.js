import {
  PREVIEW_SAMPLE_RATE,
  MAX_CARTRIDGE_BYTES,
  resourceSchema as audioLimits,
} from "./constants.js";
import { prepareExecutor } from "./executor-cache.js";
import { normalizeGraphics } from "./gpu.js";
import { FrameClock, parseFrameRate } from "./frame-clock.js";
import { createTextInputOverlay } from "./text-input.js";
import { createInputState } from "./input.js";

const eventNames = new Set(["state", "progress", "frame", "audio", "error"]);
const ownedCanvases = new WeakSet();
const asset = (name) => new URL(name, import.meta.url);
const abortError = () => new DOMException("The runtime operation was superseded", "AbortError");

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const field of Object.values(value)) {
      freeze(field);
    }
    Object.freeze(value);
  }
  return value;
}

// Internal diagnostic hosts may inspect audio objects; the public entrypoint
// exposes only the runtime controller and immutable state/diagnostics.
export function createSession({
  canvas,
  frameRate = 60,
  graphics = {},
  diagnostics = false,
  audioContext,
  smoke = false,
  readInput,
  resetInput = () => {},
  inspect = () => {},
  presentationSize,
} = {}) {
  if (!canvas || typeof canvas.getContext !== "function" || ownedCanvases.has(canvas)) {
    throw new TypeError("Supply a canvas that is not already owned by a runtime");
  }
  const display = canvas.getContext("2d", { alpha: false });
  if (!display) {
    throw new Error("A 2D presentation context is required");
  }
  let renderFps = parseFrameRate(String(frameRate));
  graphics = normalizeGraphics(graphics);
  ownedCanvases.add(canvas);
  const scope = canvas.ownerDocument.defaultView;
  const document = canvas.ownerDocument;
  const events = new EventTarget();
  const listeners = new AbortController();
  const subscriptions = new AbortController();
  const inputs = createInputState();
  let view = freeze({
    state: "idle",
    ready: false,
    error: "",
    ticks: 0,
    renderedTicks: 0,
    frames: 0,
    width: canvas.width,
    height: canvas.height,
    renderFps: setting(),
    simulationHz: 60,
  });
  let worker;
  let generation = 0;
  let startRequest = 0;
  let pending = false;
  let started = false;
  let disposed = false;
  let selected = null;
  let loadOperation;
  let retirement = Promise.resolve();
  let disposal;
  let watchdog;
  let frameTimer;
  let animation;
  let clock = new FrameClock();
  let previous = performance.now();
  let soundsPlayed = 0;
  let mixerNode = null;
  let mixerLoading = null;
  let mixerGeneration = 0;
  let output;
  const mixerPackets = [];
  const ownsAudio = !audioContext;
  const audio = {
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
      source.connect(output);
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

  async function ensureMixer() {
    if (mixerNode || !audio.lowEnabled) {
      return;
    }
    if (mixerLoading) {
      return mixerLoading;
    }
    const current = generation;
    const loading = (async () => {
      const context = audio.context;
      await context.audioWorklet.addModule(asset("./audio-worklet.js"));
      const response = await fetch(asset("./audio.wasm"));
      if (!response.ok) {
        throw new Error("Cannot load shared audio mixer.");
      }
      const module = await WebAssembly.compile(await response.arrayBuffer());
      if (current !== generation || !worker || !view.ready) {
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
          audio.mixerStatus = {
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
      node.connect(output);
    })();
    mixerLoading = loading;
    try {
      await loading;
    } catch (error) {
      if (current === generation) {
        throw error;
      }
    } finally {
      if (mixerLoading === loading) {
        mixerLoading = null;
      }
    }
  }

  function closeMixer() {
    mixerLoading = null;
    mixerGeneration = 0;
    if (mixerNode) {
      mixerNode.port.postMessage({ type: "close" });
      mixerNode.disconnect();
      mixerNode = null;
    }
    mixerPackets.length = 0;
    audio.lowEnabled = false;
    audio.mixerStatus = null;
  }

  audio.context = audioContext ?? null;

  const textInput = createTextInputOverlay({
    canvas,
    logicalSize: () => [view.width, view.height],
    send: (update) => worker?.postMessage({ type: "text-input", update }),
    onEditing(active) {
      if (active) {
        clearInput();
      }
      update({ textEditing: active });
    },
  });

  function setting() {
    return renderFps < 0 ? "uncapped" : renderFps === 0 ? "native" : renderFps;
  }
  function assertAlive() {
    if (disposed) {
      throw new Error("Runtime is disposed");
    }
  }
  function snapshot() {
    return freeze({
      ...view,
      audio: {
        muted: audio.muted === true,
        contextState: audio.context?.state ?? "uninitialized",
        sampleRate: audio.context?.sampleRate ?? null,
        played: audio.played,
        ended: audio.ended,
        peak: audio.peak,
        mixer: audio.mixerStatus ? { ...audio.mixerStatus } : null,
      },
    });
  }
  function publish(type) {
    const state = snapshot();
    inspect({ status: state, audio }, type);
    events.dispatchEvent(new CustomEvent(type, { detail: state }));
    return state;
  }
  function update(fields, type = "state") {
    view = freeze({ ...view, ...fields });
    return publish(type);
  }
  function clearInput() {
    inputs.clear();
    resetInput();
  }
  function stopOutput() {
    startRequest++;
    started = false;
    clearTimeout(frameTimer);
    clearInput();
    clock = new FrameClock();
    if (audio.source) {
      audio.source.onended = null;
      audio.source.stop();
      audio.source = null;
    }
    mixerNode?.port.postMessage({ type: "pause", paused: true });
    if (output) {
      output.gain.value = 0;
    }
  }
  function fail(message) {
    generation++;
    clearTimeout(watchdog);
    textInput.close();
    stopOutput();
    closeMixer();
    worker?.terminate();
    worker = null;
    pending = false;
    const operation = loadOperation;
    loadOperation = null;
    update({ state: "failed", ready: false, error: String(message) }, "error");
    operation?.reject(new Error(String(message)));
  }
  function armWatchdog(delay) {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => fail("Game stopped responding. Restart to try again."), delay);
  }
  function retire(current) {
    if (!current) {
      return Promise.resolve();
    }
    return new Promise((done) => {
      let finished = false;
      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        current.terminate();
        done();
      };
      const timer = setTimeout(finish, 1000);
      current.onmessage = ({ data }) => {
        data.bitmap?.close();
        if (data.type === "closed") {
          finish();
        }
      };
      current.onerror = finish;
      try {
        current.postMessage({ type: "close" });
      } catch {
        finish();
      }
    });
  }
  function stopWorker() {
    generation++;
    clearTimeout(watchdog);
    textInput.close();
    stopOutput();
    closeMixer();
    const prior = worker;
    worker = null;
    pending = false;
    loadOperation?.reject(abortError());
    loadOperation = null;
    retirement = Promise.all([retirement, retire(prior)]).then(() => {});
    return retirement;
  }
  function surfaceSize() {
    if (presentationSize) {
      return presentationSize();
    }
    const bounds = canvas.getBoundingClientRect();
    const density = scope.devicePixelRatio || 1;
    return [
      Math.max(1, Math.min(1920, Math.floor(bounds.width * density))),
      Math.max(1, Math.min(1080, Math.floor(bounds.height * density))),
    ];
  }
  function maybePlay() {
    if (started && view.sounds !== soundsPlayed) {
      audio.play();
      soundsPlayed = view.sounds;
    }
  }
  async function play() {
    assertAlive();
    if (!view.ready || !worker) {
      throw new Error("Load a game before starting playback");
    }
    const request = ++startRequest;
    if (!audio.context) {
      audio.context = new scope.AudioContext();
    }
    if (!output) {
      output = audio.context.createGain();
      output.connect(audio.context.destination);
    }
    await audio.context.resume();
    if (audio.context.state !== "running") {
      throw new Error("Audio could not start. Try again.");
    }
    if (!audio.buffer) {
      audio.buffer = audio.context.createBuffer(1, audio.samples.length, PREVIEW_SAMPLE_RATE);
      audio.buffer.copyToChannel(audio.samples, 0);
    }
    await ensureMixer();
    if (request !== startRequest || disposed || !view.ready) {
      return;
    }
    started = true;
    output.gain.value = audio.muted ? 0 : 1;
    mixerNode?.port.postMessage({ type: "pause", paused: false });
    previous = performance.now();
    clock = new FrameClock();
    update({ state: "running" });
    maybePlay();
    requestFrame();
  }
  function pause() {
    assertAlive();
    stopOutput();
    if (view.ready) {
      update({ state: "paused" });
    }
  }
  async function load(cartridge, options = {}) {
    assertAlive();
    let source;
    let file = null;
    if (typeof cartridge === "string" || cartridge instanceof URL) {
      source = new URL(cartridge, document.baseURI);
      if (!["http:", "https:"].includes(source.protocol)) {
        throw new TypeError("Cartridge URLs must use HTTP(S)");
      }
    } else {
      if (cartridge instanceof ArrayBuffer || ArrayBuffer.isView(cartridge)) {
        if (cartridge.byteLength > MAX_CARTRIDGE_BYTES) {
          throw new RangeError("PNG cartridge exceeds its container size limit");
        }
        cartridge = new Blob([cartridge], { type: "image/png" });
      }
      if (!(cartridge instanceof Blob) || !cartridge.size || cartridge.size > MAX_CARTRIDGE_BYTES) {
        throw new TypeError(
          "Load a cartridge URL, File, Blob or PNG byte buffer within the size limit",
        );
      }
      file = cartridge;
      source = new URL("game.png", document.baseURI);
    }
    const nextGraphics = normalizeGraphics(options.graphics ?? graphics);
    selected = file || source.href;
    const closing = stopWorker();
    const current = generation;
    graphics = nextGraphics;
    soundsPlayed = 0;
    audio.buffer = null;
    view = freeze({
      state: "loading",
      ready: false,
      error: "",
      ticks: 0,
      renderedTicks: 0,
      frames: 0,
      width: view.width,
      height: view.height,
      renderFps: setting(),
      simulationHz: 60,
    });
    const result = new Promise((resolve, reject) => {
      loadOperation = { resolve, reject };
    });
    publish("state");
    void (async () => {
      await closing;
      if (disposed || current !== generation) {
        return;
      }
      if (display.isContextLost?.()) {
        throw new Error("Display context unavailable. Restore it and restart.");
      }
      worker = new Worker(asset("./worker.js"), { type: "module" });
      worker.onerror = (event) => {
        event.preventDefault();
        if (current === generation) {
          fail(event.message || "Player worker failed");
        }
      };
      worker.onmessage = ({ data }) => {
        if (current !== generation || disposed) {
          data.bitmap?.close();
          return;
        }
        receive(data, current);
      };
      armWatchdog(10000);
      const executor =
        !file && source.pathname.endsWith(".luau")
          ? await prepareExecutor(asset("./luau-executor.wasm"))
          : null;
      if (disposed || current !== generation) {
        return;
      }
      worker.postMessage({
        type: "load",
        gameUrl: source.href,
        cartridge: file,
        progress: true,
        smoke,
        executor,
        graphics,
        presentationSize: surfaceSize(),
      });
    })().catch((error) => {
      if (!disposed && current === generation) {
        fail(error.message);
      }
    });
    return result;
  }
  function receive(data, current) {
    if (data.type === "text-state") {
      textInput.configure(data.state);
      return;
    }
    if (data.type === "loading") {
      armWatchdog(10000);
      update({ progress: { received: data.received, total: data.total } }, "progress");
      return;
    }
    if (data.type === "executor") {
      armWatchdog(10000);
      prepareExecutor(asset("./luau-executor.wasm"))
        .then((executor) => {
          if (current === generation && worker) {
            worker.postMessage({ type: "executor", executor });
          }
        })
        .catch((error) => {
          if (current === generation) {
            fail(error.message);
          }
        });
      return;
    }
    if (data.type === "executing") {
      armWatchdog(1000);
      return;
    }
    if (data.type === "audio-status") {
      const context = audio.context;
      audio.mixerStatus = {
        ...data.status,
        deviceRate: context?.sampleRate,
        leadFrames: audioLimits.audioLeadFrames,
        baseLatency: context?.baseLatency,
        outputLatency: context?.outputLatency ?? null,
      };
      publish("audio");
      return;
    }
    if (data.type === "audio-packet") {
      if (mixerNode && mixerGeneration === generation) {
        mixerNode.port.postMessage({ ...data, type: "packet" }, [data.buffer]);
      } else if (mixerPackets.length >= audioLimits.maxAudioTransfers) {
        fail("Initial audio schedule exceeds transfer credits.");
      } else {
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
    clearTimeout(watchdog);
    pending = false;
    if (data.type === "error") {
      fail(data.error);
      return;
    }
    if (data.audioEnabled) {
      audio.lowEnabled = true;
      if (started) {
        ensureMixer().catch((error) => fail(error.message));
      }
    }
    if (data.type === "stepped") {
      update({ ticks: data.ticks });
      requestFrame();
      return;
    }
    if (!["ready", "frame"].includes(data.type)) {
      fail("Invalid player response.");
      return;
    }
    if (data.type === "ready") {
      audio.samples = new Float32Array(data.sample);
      audio.peak = audio.samples.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);
    }
    const width = data.presentationWidth || data.width;
    const height = data.presentationHeight || data.height;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    if (data.bitmap) {
      display.drawImage(data.bitmap, 0, 0);
      data.bitmap.close();
    } else {
      display.putImageData(new ImageData(new Uint8ClampedArray(data.pixels), width, height), 0, 0);
    }
    const fields = {};
    for (const name of [
      "title",
      "ticks",
      "sounds",
      "spriteX",
      "spriteY",
      "x",
      "y",
      "hash",
      "width",
      "height",
      "smoothPresentation",
      "metrics",
      "memory",
      "startup",
      "graphics",
    ]) {
      if (data[name] !== undefined) {
        fields[name] = data[name];
      }
    }
    const operation = data.type === "ready" ? loadOperation : null;
    if (operation) {
      loadOperation = null;
    }
    const presented = update(
      {
        ...fields,
        state: started ? "running" : view.state === "paused" ? "paused" : "ready",
        ready: true,
        error: "",
        renderedTicks: data.ticks,
        presentationWidth: width,
        presentationHeight: height,
        frames: view.frames + 1,
      },
      "frame",
    );
    if (data.type === "ready") {
      if (current === generation) {
        publish("state");
      }
      operation?.resolve(presented);
    }
    maybePlay();
    requestFrame();
  }
  function requestFrame(now = performance.now(), displayOpportunity = false) {
    clearTimeout(frameTimer);
    const current = Math.max(now, previous);
    const delta = Math.min((current - previous) / 1000, 0.1);
    previous = current;
    if (!started || !worker || document.hidden || (smoke && view.ticks >= 120)) {
      return;
    }
    clock.advance(delta);
    if (!smoke && renderFps === 0 && !displayOpportunity) {
      return;
    }
    if (pending) {
      return;
    }
    const { steps, render } = smoke
      ? { steps: 1, render: true }
      : clock.take(renderFps, displayOpportunity);
    if (!steps && !render) {
      frameTimer = setTimeout(requestFrame, clock.delay(renderFps));
      return;
    }
    pending = true;
    armWatchdog(1000);
    const input = textInput.editing()
      ? { buttons: 0, pointer: false, x: 0, y: 0 }
      : readInput
        ? readInput(steps > 0)
        : inputs.sample(view.width, view.height, steps > 0);
    worker.postMessage({
      type: "step",
      diagnostics,
      steps,
      render,
      input,
      presentationSize: surfaceSize(),
    });
  }
  function animate(now) {
    if (disposed) {
      return;
    }
    requestFrame(now, true);
    animation = scope.requestAnimationFrame(animate);
  }
  const observer = new scope.ResizeObserver(() => textInput.reposition());
  observer.observe(canvas);
  scope.addEventListener("blur", pause, { signal: listeners.signal });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden) {
        pause();
      }
    },
    { signal: listeners.signal },
  );
  canvas.addEventListener(
    "contextlost",
    (event) => {
      event.preventDefault();
      fail("Display context lost. Restore it and restart the game.");
    },
    { signal: listeners.signal },
  );
  animation = scope.requestAnimationFrame(animate);

  const runtime = {
    get state() {
      return view.state;
    },
    getSnapshot: snapshot,
    on(type, listener) {
      assertAlive();
      if (!eventNames.has(type) || typeof listener !== "function") {
        throw new TypeError("Unsupported runtime event or listener");
      }
      const receive = (event) => listener(event.detail);
      events.addEventListener(type, receive, { signal: subscriptions.signal });
      return () => events.removeEventListener(type, receive);
    },
    load,
    play,
    pause,
    async restart() {
      assertAlive();
      if (selected === null) {
        throw new Error("No cartridge has been selected");
      }
      const resume = started;
      await load(selected);
      if (resume) {
        await play();
      }
    },
    setInput(source, value) {
      assertAlive();
      inputs.set(source, value);
    },
    pulseInput(bindings) {
      assertAlive();
      inputs.pulse(bindings);
    },
    clearInput() {
      assertAlive();
      clearInput();
    },
    setMuted(value) {
      assertAlive();
      if (typeof value !== "boolean") {
        throw new TypeError("Muted must be boolean");
      }
      audio.muted = value;
      if (output) {
        output.gain.value = started && !value ? 1 : 0;
      }
      publish("audio");
    },
    setFrameRate(value) {
      assertAlive();
      renderFps = parseFrameRate(String(value));
      clock.nextDraw = clock.elapsed;
      update({ renderFps: setting() });
    },
    async unload() {
      assertAlive();
      selected = null;
      const closing = stopWorker();
      update({ state: "idle", ready: false, error: "" });
      await closing;
    },
    dispose() {
      if (disposal) {
        return disposal;
      }
      let completion;
      disposal = new Promise((resolve, reject) => {
        completion = { resolve, reject };
      });
      disposed = true;
      const closing = stopWorker();
      listeners.abort();
      observer.disconnect();
      textInput.destroy();
      scope.cancelAnimationFrame(animation);
      update({ state: "disposed", ready: false });
      subscriptions.abort();
      void (async () => {
        try {
          await closing;
          output?.disconnect();
          if (ownsAudio && audio.context && audio.context.state !== "closed") {
            await audio.context.close();
          }
        } finally {
          ownedCanvases.delete(canvas);
        }
      })().then(completion.resolve, completion.reject);
      return disposal;
    },
  };
  return { runtime, inspect: () => ({ status: snapshot(), audio }) };
}
