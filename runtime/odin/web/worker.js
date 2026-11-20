import {
  INPUT_BUTTON_MASK,
  BUTTON_WHEEL_UP,
  BUTTON_WHEEL_DOWN,
  resourceSchema as audioLimits,
  PROFILE_OGG,
} from "./constants.js";
import {
  inspectGuest,
  checkExecutor,
  loadSource,
  uploadGraphics,
  submitDrawing,
  rasterizeDrawing,
  negotiateProfile,
  configureResources,
  submitResources,
  deliverResources,
} from "./policy.js";
import { loadCartridge, contentImports } from "./cartridge.js";
import { fetchCartridge, discardCachedCartridge } from "./cartridge-cache.js";
import { openSaveSlot } from "./save.js";
import { createTextInputSession } from "./text-session.js";
import { normalizeGraphics, createGpu } from "./gpu.js";
import { createOggPump, prepareOggDecoder } from "./ogg.js";

let game, runtime;
let saveSlot;
let textSession;
let gpu;
let presentationSize = [1920, 1080];
let smoke = false;
let lastTick = 0;
let logicalSize = [640, 360];
const imports = { env: { sin: Math.sin } };
let startup;
let resourceTrace = false;
let initialMemory;
let executorRequest;
let closing = false;
const audioTransfers = Array.from({ length: audioLimits.maxAudioTransfers }, () => ({
  buffer: null,
  busy: false,
  capacity: 0,
}));
let pendingAudioBytes = 0;
let audioPort;
let audioPrimed = false;
let audioConnected = false;
let audioCapacityWaiter;
let oggPump, oggTimer, oggLoading;
async function initializeOgg() {
  if (oggPump || game?.game_profile?.() !== PROFILE_OGG) {
    return;
  }
  if (oggLoading) {
    await oggLoading;
    return;
  }
  let needed = false;
  for (let index = 0; index < audioLimits.maxOggStreams; index++) {
    const pointer = runtime.runtime_ogg_request(index);
    needed ||=
      new Uint32Array(runtime.memory.buffer, pointer, audioLimits.oggRequestWords)[0] !== 0;
  }
  if (!needed) {
    return;
  }
  const current = runtime;
  oggLoading = createOggPump(current);
  try {
    const pump = await oggLoading;
    if (current !== runtime) {
      pump.close();
      return;
    }
    oggPump = pump;
  } finally {
    oggLoading = null;
  }
}
async function pumpOgg() {
  await initializeOgg();
  oggPump?.pump();
  const drained = drainAudio();
  if (audioCapacityWaiter && audioBatchAvailable()) {
    const resume = audioCapacityWaiter;
    audioCapacityWaiter = null;
    resume();
  }
  if (!audioPrimed && drained) {
    for (let index = 0; index < audioLimits.maxOggStreams; index++) {
      const pointer = runtime.runtime_ogg_request(index);
      const request = new Uint32Array(runtime.memory.buffer, pointer, audioLimits.oggRequestWords);
      if (request[0] && request[6]) {
        return;
      }
    }
    audioPrimed = true;
    // Ordered behind every initial packet on the same port. The worklet may
    // consume batches to return credits, but holds its clock until this arrives.
    audioPort.postMessage({ type: "start" });
  }
}
function closeOgg() {
  clearInterval(oggTimer);
  oggPump?.close();
  oggPump = null;
}
function audioBatchAvailable() {
  return !runtime?.runtime_audio_batches_available || runtime.runtime_audio_batches_available() > 0;
}
async function waitForAudioCapacity() {
  if (!audioConnected) {
    return;
  }
  drainAudio();
  if (!audioBatchAvailable()) {
    await new Promise((resolve) => {
      audioCapacityWaiter = resolve;
    });
  }
}
function drainAudio() {
  if (!audioPort || !runtime?.runtime_audio_enabled?.()) {
    return;
  }
  for (let id = 0; id < audioTransfers.length; id++) {
    const slot = audioTransfers[id];
    if (slot.busy) {
      continue;
    }
    const bytes = pendingAudioBytes || runtime.runtime_audio_export();
    if (!bytes) {
      return true;
    }
    if (bytes < 0) {
      throw new Error("Audio packet exceeds transfer capacity.");
    }
    pendingAudioBytes = bytes;
    // One aggregate credit budget, including buffers currently owned by the
    // worklet. Discard oversized idle buffers on this producer, never in process().
    let retained = 0;
    for (const other of audioTransfers) {
      if (!other.busy && other !== slot) {
        other.buffer = null;
        other.capacity = 0;
      }
      retained += other.capacity;
    }
    const capacity = Math.max(slot.capacity, bytes);
    if (retained - slot.capacity + capacity > audioLimits.maxAudioPacketBytes) {
      return;
    }
    if (!slot.buffer || slot.buffer.byteLength < bytes) {
      slot.buffer = new ArrayBuffer(bytes);
      slot.capacity = bytes;
    }
    new Uint8Array(slot.buffer, 0, bytes).set(
      new Uint8Array(runtime.memory.buffer, runtime.runtime_audio_packet(), bytes),
    );
    audioPort.postMessage({ type: "packet", id, bytes, buffer: slot.buffer }, [slot.buffer]);
    slot.buffer = null;
    slot.busy = true;
    pendingAudioBytes = 0;
  }
}
function requestExecutor() {
  return new Promise((resolve) => {
    executorRequest = resolve;
    self.postMessage({ type: "executor" });
  });
}

async function fetchBytes(url, limit = 1024 * 1024, onProgress) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load ${new URL(url, location.href).pathname}.`);
  }
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Module or PNG exceeds prototype size limit.");
      }
      chunks.push(value);
      onProgress?.(size, Number(response.headers.get("content-length")) || 0);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes.buffer;
}

function submit() {
  return submitDrawing(game, runtime);
}
function rasterize(drawing) {
  rasterizeDrawing(runtime, drawing);
}
function logicalHash() {
  if (!runtime.runtime_materialize()) {
    throw new Error("GPU logical snapshot synchronization failed.");
  }
  return runtime.runtime_hash() >>> 0;
}
function presentFrame(width, height) {
  if (gpu) {
    return gpu.present(
      runtime.memory,
      runtime.runtime_gpu_version_low() || runtime.runtime_gpu_version_high()
        ? 0
        : runtime.runtime_logical_pixels(),
      runtime.runtime_gpu_preview(),
      runtime.runtime_gpu_mask(),
      width,
      height,
      ...presentationSize,
      runtime.runtime_gpu_dx(),
      runtime.runtime_gpu_dy(),
      runtime.runtime_gpu_background(),
      runtime.runtime_gpu_version_low(),
      runtime.runtime_gpu_version_high(),
    );
  }
  const pointer = runtime.runtime_presentation(...presentationSize);
  const presentationWidth = runtime.runtime_presentation_width();
  const presentationHeight = runtime.runtime_presentation_height();
  return {
    presentationWidth,
    presentationHeight,
    smoothPresentation: Boolean(runtime.runtime_presentation_active()),
    pixels: new Uint8Array(
      runtime.memory.buffer,
      pointer,
      presentationWidth * presentationHeight * 4,
    ).slice().buffer,
  };
}

function frame(present = true, diagnostics = true) {
  const started = performance.now();
  const uploads = gpu ? gpu.metrics.uploadBytes + gpu.metrics.textureUploadBytes : 0;
  const drawing = submit();
  const { record } = drawing;
  rasterize(drawing);
  logicalSize = [drawing.width, drawing.height];
  lastTick = record.ticks;
  return {
    width: drawing.width,
    height: drawing.height,
    ...(present ? presentFrame(drawing.width, drawing.height) : {}),
    metrics: {
      renderMs: performance.now() - started,
      gpuUploadBytes: gpu ? gpu.metrics.uploadBytes + gpu.metrics.textureUploadBytes - uploads : 0,
      gpuCacheBytes: gpu?.metrics.cacheBytes || 0,
      gpuTextureBytes: gpu?.metrics.textureBytes || 0,
      gpuAttachmentUploadBytes: gpu?.metrics.attachmentUploadBytes || 0,
      gpuAttachmentReadbackBytes: gpu?.metrics.attachmentReadbackBytes || 0,
      gpuAttachmentBytes: gpu?.metrics.attachmentBytes || 0,
      gpuFrameBytes: gpu?.metrics.frameBytes || 0,
      gpuSnapshotReadbackBytes: gpu?.metrics.snapshotReadbackBytes || 0,
      gpuPresentationUploadBytes: gpu?.metrics.presentationUploadBytes || 0,
      gpuDirectPresents: gpu?.metrics.directPresents || 0,
      meshUploads: gpu?.metrics.meshUploads || 0,
      memory: memoryReport(),
      resourceBytes: runtime.runtime_resource_bytes(),
      cpuQualityBytes: runtime.runtime_cpu_bytes(),
    },
    ticks: record.ticks,
    sounds: record.sounds,
    audioEnabled: !!runtime.runtime_audio_enabled?.(),
    spriteX: record.spriteX,
    spriteY: record.spriteY,
    x: record.x,
    y: record.y,
    hash: diagnostics || smoke || resourceTrace || !gpu ? logicalHash() : null,
    ...(resourceTrace
      ? {
          resourceHash: runtime.runtime_resource_hash() >>> 0,
          resourceBytes: runtime.runtime_resource_bytes() >>> 0,
        }
      : {}),
  };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "close") {
      closing = true;
      closeOgg();
      textSession?.close();
      audioPort?.close();
      await saveSlot?.settled();
      saveSlot?.close();
      gpu?.close();
      self.postMessage({ type: "closed" });
      return;
    }
    if (closing) {
      return;
    }
    if (data.type === "audio-connect") {
      audioConnected = true;
      audioPort?.close();
      audioPrimed = false;
      const port = data.port;
      port.onmessage = ({ data: message }) => {
        if (message.type === "ready") {
          audioPort = port;
          self.onmessage({ data: { type: "audio-prime" } });
        } else {
          self.onmessage({ data: { ...message, type: `audio-${message.type}` } });
        }
      };
      port.start();
      return;
    }
    if (data.type === "audio-prime") {
      await pumpOgg();
      return;
    }
    if (data.presentationSize) {
      if (
        !Array.isArray(data.presentationSize) ||
        data.presentationSize.length !== 2 ||
        data.presentationSize.some((v) => !Number.isInteger(v) || v < 1)
      ) {
        throw new Error("Invalid presentation dimensions.");
      }
      presentationSize = [
        Math.min(1920, data.presentationSize[0]),
        Math.min(1080, data.presentationSize[1]),
      ];
    }
    if (data.type === "audio-recycle") {
      const slot = audioTransfers[data.id];
      if (!slot || !slot.busy) {
        throw new Error("Invalid recycled audio transfer.");
      }
      slot.buffer = data.buffer;
      slot.busy = false;
      await pumpOgg();
      return;
    }
    if (data.type === "audio-feedback") {
      new Uint8Array(
        runtime.memory.buffer,
        runtime.runtime_audio_feedback_pointer(),
        data.bytes,
      ).set(new Uint8Array(data.buffer, 0, data.bytes));
      if (runtime.runtime_audio_feedback(data.bytes) !== 1) {
        throw new Error("Invalid audio feedback.");
      }
      const view = new DataView(data.buffer, 0, data.bytes);
      const wide = (at) => view.getUint32(at, true) + view.getUint32(at + 4, true) * 2 ** 32;
      self.postMessage({
        type: "audio-status",
        status: {
          frame: wide(16),
          epoch: view.getUint32(12, true),
          lateEvents: wide(32),
          underrunFrames: wide(40),
          rejectedWrites: wide(48),
          completed: wide(56),
        },
      });
      audioPort.postMessage({ type: "feedback-recycle", id: data.id, buffer: data.buffer }, [
        data.buffer,
      ]);
      await pumpOgg();
      return;
    }
    if (data.type === "executor" && executorRequest) {
      const resolve = executorRequest;
      executorRequest = null;
      resolve(data.executor);
      return;
    }
    if (data.type === "load") {
      closeOgg();
      const graphics = normalizeGraphics(data.graphics);
      gpu?.close();
      gpu = null;
      let graphicsFallback = "";
      if (graphics.backend !== "cpu") {
        try {
          gpu = await createGpu(graphics);
        } catch (error) {
          if (graphics.backend === "gpu" || graphics.surfaceSamples) {
            throw error;
          }
          graphicsFallback = error.message;
        }
      }
      imports.env.raster_gpu = (...args) => gpu.raster(runtime.memory, ...args);
      imports.env.stage_frame_gpu = (...args) => gpu.stageFrame(runtime.memory, ...args);
      imports.env.read_frame_gpu = (...args) => gpu.readFrame(runtime.memory, ...args);
      imports.env.publish_frame_gpu = (...args) => gpu.publishFrame(...args);
      imports.env.invalidate_frame_gpu = () => gpu.invalidateFrames();
      imports.env.mesh_gpu = (...args) => gpu.queueMesh(runtime.memory, ...args);
      imports.env.texture_gpu = (...args) => gpu.queueTexture(...args);
      resourceTrace = !!data.resourceTrace;
      const url = new URL(data.gameUrl, location.href);
      if (url.origin !== location.origin) {
        throw new Error("Game URL must use the player origin.");
      }
      const start = performance.now();
      const isSource = url.pathname.endsWith(".luau");
      const isPNG = !!data.cartridge || url.pathname.toLowerCase().endsWith(".png");
      let lastProgress = -Infinity;
      const reportProgress = (received, total) => {
        if (data.progress !== true) {
          return;
        }
        const now = performance.now();
        if (now - lastProgress < 100 && received !== total) {
          return;
        }
        lastProgress = now;
        self.postMessage({ type: "loading", received, total });
      };
      const [input, runtimeBytes] = await Promise.all([
        data.cartridge ||
          (isPNG
            ? fetchCartridge(url, { onProgress: reportProgress })
            : fetchBytes(url, undefined, reportProgress)),
        fetchBytes(gpu ? "./runtime-gpu.wasm" : "./runtime.wasm", undefined, reportProgress),
      ]);
      if (closing) {
        return;
      }
      runtime = (await WebAssembly.instantiate(runtimeBytes, imports)).instance.exports;
      if (closing) {
        return;
      }
      if (
        !gpu &&
        runtime.runtime_cpu_configure(
          graphics.ssaa === "1080p" ? 6 : graphics.ssaa === "2x" ? 2 : 1,
          Number(graphics.pixelSnap),
          Number(graphics.smoothPan),
        ) !== 1
      ) {
        throw new Error("CPU quality configuration failed.");
      }
      if (
        gpu &&
        runtime.runtime_gpu_configure(
          Number(graphics.pixelSnap),
          Number(graphics.smoothPan),
          Number(graphics.residentMeshes),
        ) !== 1
      ) {
        throw new Error("Runtime does not support GPU execution.");
      }
      let cartridge = null;
      if (isPNG) {
        try {
          cartridge = await loadCartridge(runtime, input, { onProgress: reportProgress });
        } catch (error) {
          if (!data.cartridge) {
            await discardCachedCartridge(url);
          }
          throw error;
        }
      }
      let executor = isSource ? data.executor : null;
      let gameBytes = cartridge ? cartridge.code : input;
      let source = null;
      if (isSource || cartridge?.language === "luau") {
        source = gameBytes;
        executor ||= cartridge
          ? await requestExecutor()
          : { bytes: await fetchBytes("./luau-executor.wasm") };
        gameBytes = executor.bytes;
      }
      if (cartridge?.profile === PROFILE_OGG) {
        await prepareOggDecoder(() => fetchBytes("./vorbis.wasm", undefined, reportProgress));
      }
      const fetched = performance.now();
      self.postMessage({ type: "executing" });
      const gameModule = inspectGuest(gameBytes, executor?.module, { luauExecutor: !!source });
      const compiled = performance.now();
      await saveSlot?.settled();
      if (closing) {
        return;
      }
      saveSlot?.close();
      game = undefined;
      const identity = cartridge
        ? new Uint8Array(
            runtime.memory.buffer,
            runtime.runtime_cartridge_buffer(),
            cartridge.length,
          )
        : input;
      saveSlot = await openSaveSlot(identity, () => game, cartridge);
      if (closing) {
        saveSlot.close();
        return;
      }
      textSession?.close();
      textSession = createTextInputSession(() => game, {
        onConfigure: (state) => self.postMessage({ type: "text-state", state }),
      });
      game = (
        await WebAssembly.instantiate(gameModule, {
          env: {
            ...imports.env,
            ...contentImports(runtime, () => game, !!cartridge),
            ...saveSlot.imports,
            ...textSession.imports,
          },
        })
      ).exports;
      if (closing) {
        return;
      }
      const instantiated = performance.now();
      initialMemory = game.memory.buffer.byteLength;
      runtime.runtime_init();
      const runtimeInitialized = performance.now();
      game._initialize?.();
      if (source) {
        loadSource(game, source);
      }
      negotiateProfile(game, cartridge);
      configureResources(game, runtime);
      game.game_init();
      checkExecutor(game);
      submitResources(game, runtime);
      if (cartridge?.profile === PROFILE_OGG) {
        await initializeOgg();
        oggPump?.pump();
        oggTimer = setInterval(async () => {
          try {
            await pumpOgg();
          } catch (error) {
            closeOgg();
            self.postMessage({ type: "error", error: error.message || String(error) });
          }
        }, 10);
      }
      if (cartridge && game.game_display_mode?.() !== cartridge.display) {
        throw new Error("Cartridge initial display does not match its metadata.");
      }
      uploadGraphics(game, runtime);
      const initialized = performance.now();
      smoke = !!data.smoke;
      const sample = new Float32Array(
        runtime.memory.buffer,
        runtime.runtime_sample(),
        16000,
      ).slice();
      const output = frame(true, false);
      drainAudio();
      startup = {
        fetchMs: fetched - start,
        compileMs: compiled - fetched,
        instantiateMs: instantiated - compiled,
        runtimeInitMs: runtimeInitialized - instantiated,
        gameInitMs: initialized - runtimeInitialized,
        firstFrameMs: performance.now() - initialized,
        // A PNG requests its executor during this interval. Loose-source loads
        // may arrive with an executor prepared before the worker's clock starts.
        totalMs: performance.now() - start + (data.executor?.cache?.prepareMs || 0),
        executorCache: executor?.cache || { enabled: false, hit: false },
      };
      self.postMessage(
        {
          type: "ready",
          graphics: {
            requested: graphics,
            effective: gpu ? "gpu" : "cpu",
            fallback: graphicsFallback,
          },
          ...output,
          title: cartridge?.title,
          startup,
          memory: memoryReport(),
          sample: sample.buffer,
        },
        [output.bitmap || output.pixels, sample.buffer],
      );
    } else if (data.type === "text-input") {
      // Stale or invalid UI messages never mutate a newer field or stop a game.
      textSession?.accept(data.update);
    } else if (data.type === "step") {
      if (
        !game ||
        !Number.isInteger(data.steps) ||
        data.steps < 0 ||
        data.steps > 5 ||
        (data.render !== undefined && typeof data.render !== "boolean") ||
        (data.steps === 0 && data.render !== true)
      ) {
        throw new Error("Invalid step request.");
      }
      let output;
      const uploadsBefore = gpu ? gpu.metrics.uploadBytes + gpu.metrics.textureUploadBytes : 0;
      for (let i = 0; i < data.steps && (!smoke || lastTick < 120); i++) {
        await waitForAudioCapacity();
        let buttons = smoke ? (lastTick < 60 ? 2 : lastTick === 60 ? 16 : 0) : data.input.buttons;
        if (i > 0) {
          buttons = (buttons & ~(BUTTON_WHEEL_UP | BUTTON_WHEEL_DOWN)) >>> 0;
        }
        deliverResources(game, runtime);
        saveSlot?.beginTick();
        textSession?.beginTick();
        game.game_update(
          buttons,
          smoke ? 0 : Number(data.input.pointer),
          smoke ? 0 : data.input.x,
          smoke ? 0 : data.input.y,
        );
        checkExecutor(game);
        submitResources(game, runtime);
        drainAudio();
        lastTick++;
      }
      if (data.render !== false) {
        output = frame(false, data.diagnostics !== false);
        const started = performance.now();
        const uploads = gpu ? gpu.metrics.textureUploadBytes : 0;
        Object.assign(output, presentFrame(output.width, output.height));
        output.metrics.renderMs += performance.now() - started;
        output.metrics.gpuUploadBytes += gpu ? gpu.metrics.textureUploadBytes - uploads : 0;
        output.metrics.gpuUploadBytes = gpu
          ? gpu.metrics.uploadBytes + gpu.metrics.textureUploadBytes - uploadsBefore
          : 0;
        self.postMessage({ type: "frame", ...output }, [output.bitmap || output.pixels]);
      } else {
        self.postMessage({
          type: "stepped",
          ticks: lastTick,
          audioEnabled: !!runtime.runtime_audio_enabled?.(),
        });
      }
    } else if (data.type === "capture") {
      if (!game) {
        throw new Error("No game is loaded.");
      }
      logicalHash();
      const pixels = new Uint8Array(
        runtime.memory.buffer,
        runtime.runtime_logical_pixels(),
        logicalSize[0] * logicalSize[1] * 4,
      ).slice().buffer;
      self.postMessage({ type: "capture", pixels, width: logicalSize[0], height: logicalSize[1] }, [
        pixels,
      ]);
    } else if (data.type === "benchmark") {
      const warmupFrames = data.warmupFrames ?? 0;
      if (
        !game ||
        !Array.isArray(data.masks) ||
        !data.masks.length ||
        data.masks.length > 10000 ||
        !Number.isInteger(warmupFrames) ||
        warmupFrames < 0 ||
        warmupFrames >= data.masks.length ||
        data.masks.some((mask) => !Number.isInteger(mask) || mask < 0 || mask > INPUT_BUTTON_MASK)
      ) {
        throw new Error("Invalid benchmark replay.");
      }
      const timings = [],
        traces = [];
      let peakLinear = game.memory.buffer.byteLength,
        peakHeap = 0;
      let resourceBaseline = [0, 0, 0];
      for (let pass = 0; pass < (data.diagnostic ? 1 : 7); pass++) {
        configureResources(game, runtime);
        saveSlot?.beginTick();
        textSession?.close();
        textSession?.beginTick();
        game.game_init();
        checkExecutor(game);
        submitResources(game, runtime);
        resourceBaseline = [0, 1, 2].map((index) =>
          Number(runtime.runtime_resource_stat?.(index) || 0),
        );
        for (const [frameIndex, mask] of data.masks.entries()) {
          const t0 = performance.now();
          deliverResources(game, runtime);
          saveSlot?.beginTick();
          textSession?.beginTick();
          game.game_update(mask, 0, 0, 0);
          checkExecutor(game);
          submitResources(game, runtime);
          const t1 = performance.now();
          if (frameIndex < warmupFrames) {
            continue;
          }
          const drawing = submit();
          const { record } = drawing;
          const t2 = performance.now();
          rasterize(drawing);
          logicalSize = [drawing.width, drawing.height];
          let t3;
          if (gpu) {
            const output = presentFrame(drawing.width, drawing.height);
            gpu.finish();
            output.bitmap.close();
            t3 = performance.now();
          } else {
            const presentationPointer = runtime.runtime_presentation(...presentationSize);
            const presentationBytes =
              runtime.runtime_presentation_width() * runtime.runtime_presentation_height() * 4;
            t3 = performance.now();
            new Uint8Array(runtime.memory.buffer, presentationPointer, presentationBytes).slice();
          }
          const t4 = performance.now();
          if (pass >= 2) {
            timings.push([t1 - t0, t2 - t1, t3 - t2, t4 - t3]);
          }
          if (pass === 2) {
            traces.push({ hash: logicalHash(), sounds: record.sounds });
          }
          peakLinear = Math.max(peakLinear, game.memory.buffer.byteLength);
          peakHeap = Math.max(peakHeap, game.game_heap_peak?.() || 0);
        }
      }
      self.postMessage({
        type: "benchmark",
        startup,
        memory: {
          ...memoryReport(),
          peakLinear,
          peakHeap: game.game_heap_peak ? peakHeap : null,
        },
        cpuStats: {
          allocatedBytes: runtime.runtime_cpu_bytes?.() || 0,
          attachmentImportBytes: Number(runtime.runtime_cpu_stat?.(0) || 0),
          attachmentResolveBytes: Number(runtime.runtime_cpu_stat?.(1) || 0),
          batches: Number(runtime.runtime_cpu_stat?.(2) || 0),
          sequences: Number(runtime.runtime_cpu_stat?.(3) || 0),
        },
        timings,
        traces,
        gpuStats: gpu ? { ...gpu.metrics, gpuPresentation: true } : null,
        resourceStats: {
          packetBytes: Number(runtime.runtime_resource_stat?.(0) || 0) - resourceBaseline[0],
          hostCopyBytes: Number(runtime.runtime_resource_stat?.(1) || 0) - resourceBaseline[1],
          pixelWork: Number(runtime.runtime_resource_stat?.(2) || 0) - resourceBaseline[2],
          peakResourceBytes: Number(runtime.runtime_resource_stat?.(3) || 0),
          currentResourceBytes: runtime.runtime_resource_bytes(),
          triangles: Number(runtime.runtime_resource_stat?.(4) || 0),
          voxelCells: Number(runtime.runtime_resource_stat?.(5) || 0),
          voxelFaces: Number(runtime.runtime_resource_stat?.(6) || 0),
          voxelRebuilds: Number(runtime.runtime_resource_stat?.(7) || 0),
          sourceBytes: Number(runtime.runtime_resource_stat?.(8) || 0),
          geometryBytes: Number(runtime.runtime_resource_stat?.(9) || 0),
          depthBytes: Number(runtime.runtime_resource_stat?.(10) || 0),
        },
      });
    } else {
      throw new Error("Unknown player request.");
    }
  } catch (error) {
    closeOgg();
    gpu?.close();
    gpu = null;
    runtime?.runtime_resource_close?.();
    game = runtime = null;
    self.postMessage({ type: "error", error: error.message || String(error) });
  }
};

function memoryReport() {
  return {
    initialLinear: initialMemory,
    currentLinear: game.memory.buffer.byteLength,
    runtimeLinear: runtime.memory.buffer.byteLength,
    vorbisLinear: oggPump?.memoryBytes || 0,
    heapBytes: game.game_heap_bytes?.() ?? null,
    heapPeak: game.game_heap_peak?.() ?? null,
  };
}
