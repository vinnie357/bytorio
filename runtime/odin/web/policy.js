import {
  FRAME_BYTES,
  MAX_GAME_BYTES,
  MAX_MEMORY_BYTES,
  MAX_LUAU_MEMORY_BYTES,
  MAX_LUAU_SOURCE_BYTES,
  WASM_PAGE_BYTES,
  resourceSchema,
  PROFILE_RESOURCE,
  RESOURCE_ABI_VERSION,
  RESOURCE_SDK_VERSION,
  RESOURCE_FEATURES,
  RESOURCE_PROTOCOL,
  RESOURCE_EXPORTS,
  PROFILE_3D,
  PREVIEW_3D_SDK,
  PREVIEW_3D_FEATURES,
  PREVIEW_3D_PROTOCOL,
  PROFILE_TEXTURED_3D,
  TEXTURED_3D_SDK,
  TEXTURED_3D_FEATURES,
  TEXTURED_3D_PROTOCOL,
  PROFILE_EFFECTS_3D,
  EFFECTS_3D_SDK,
  EFFECTS_3D_FEATURES,
  EFFECTS_3D_PROTOCOL,
  PROFILE_ALPHA_3D,
  ALPHA_3D_SDK,
  ALPHA_3D_FEATURES,
  ALPHA_3D_PROTOCOL,
  PROFILE_OGG,
  OGG_SDK,
  OGG_PROTOCOL,
  OGG_FEATURES,
} from "./constants.js";
export { FRAME_BYTES, MAX_GAME_BYTES };
export const MAX_PAGES = MAX_MEMORY_BYTES / WASM_PAGE_BYTES;
const DISPLAY_DIMENSION_BITS = 16;
const DISPLAY_DIMENSION_MASK = 2 ** DISPLAY_DIMENSION_BITS - 1;
const resourceProtocols = new WeakMap();

// A fixed profile is negotiated as a complete tuple before calling game_init.
// There are no optional feature bits in resource-av-1.
export function negotiateProfile(game, cartridge = null) {
  const profile = game.game_profile?.() ?? 1;
  const abi = game.game_abi();
  const sdk = game.game_sdk_version?.();
  const preview = profile === PROFILE_3D;
  const textured = profile === PROFILE_TEXTURED_3D;
  const effects = profile === PROFILE_EFFECTS_3D;
  const alpha = profile === PROFILE_ALPHA_3D;
  const ogg = profile === PROFILE_OGG;
  const expectedSdk = ogg
    ? OGG_SDK
    : effects
      ? EFFECTS_3D_SDK
      : alpha
        ? ALPHA_3D_SDK
        : textured
          ? TEXTURED_3D_SDK
          : preview
            ? PREVIEW_3D_SDK
            : RESOURCE_SDK_VERSION;
  const expectedProtocol = ogg
    ? OGG_PROTOCOL
    : effects
      ? EFFECTS_3D_PROTOCOL
      : alpha
        ? ALPHA_3D_PROTOCOL
        : textured
          ? TEXTURED_3D_PROTOCOL
          : preview
            ? PREVIEW_3D_PROTOCOL
            : RESOURCE_PROTOCOL;
  const expectedFeatures = ogg
    ? OGG_FEATURES
    : effects
      ? EFFECTS_3D_FEATURES
      : alpha
        ? ALPHA_3D_FEATURES
        : textured
          ? TEXTURED_3D_FEATURES
          : preview
            ? PREVIEW_3D_FEATURES
            : RESOURCE_FEATURES;
  if (profile === 1 && (game.game_resource_protocol?.() ?? 0) > RESOURCE_PROTOCOL) {
    throw new Error("Experimental 3D requires its explicit cartridge profile.");
  }
  if (
    cartridge &&
    (profile !== cartridge.profile || abi !== cartridge.abi || sdk !== cartridge.sdk)
  ) {
    throw new Error("Cartridge SDK, ABI or profile does not match its metadata.");
  }
  if (
    game.game_frame_size() !== FRAME_BYTES ||
    (profile === 1
      ? abi !== 1
      : (!preview && !textured && !alpha && !effects && !ogg && profile !== PROFILE_RESOURCE) ||
        abi !== RESOURCE_ABI_VERSION ||
        sdk !== expectedSdk)
  ) {
    throw new Error("Unsupported game ABI or profile.");
  }
  if (
    profile !== 1 &&
    (game.game_resource_protocol?.() !== expectedProtocol ||
      game.game_required_features?.() !== expectedFeatures)
  ) {
    throw new Error("Unsupported resource profile features or protocol.");
  }
  if (profile !== 1) {
    for (const { name } of RESOURCE_EXPORTS) {
      if (typeof game[name] !== "function") {
        throw new Error(`Missing resource profile export: ${name}.`);
      }
    }
  }
  return profile;
}

// Configure the negotiated profile; legacy experimental transports retain their bounds.
export function configureResources(game, runtime) {
  negotiateProfile(game);
  if (!game.game_resource_protocol) {
    return;
  }
  const protocol = game.game_resource_protocol();
  if (
    protocol < 1 ||
    protocol > resourceSchema.version ||
    !Number.isInteger(protocol) ||
    !runtime.runtime_resource_reset
  ) {
    throw new Error("Unsupported internal resource protocol.");
  }
  for (const name of [
    "game_resource_configure",
    "game_commit",
    "game_commit_size",
    "game_commit_ack",
  ]) {
    if (typeof game[name] !== "function") {
      throw new Error(`Missing resource export: ${name}.`);
    }
  }
  if (protocol >= 2) {
    for (const name of [
      "game_resource_mailbox",
      "game_resource_mailbox_capacity",
      "game_resource_mailbox_size",
    ]) {
      if (typeof game[name] !== "function") {
        throw new Error(`Missing resource export: ${name}.`);
      }
    }
    const capacity = game.game_resource_mailbox_capacity();
    if (
      !Number.isInteger(capacity) ||
      capacity <
        (protocol >= 3 ? resourceSchema.mailboxCapacity : resourceSchema.legacyMailboxCapacity) ||
      capacity > MAX_MEMORY_BYTES
    ) {
      throw new Error("Invalid completion mailbox capacity.");
    }
  }
  const session = runtime.runtime_resource_reset(protocol);
  if (!session || game.game_resource_configure(session) !== 1) {
    throw new Error("Resource configuration rejected.");
  }
  resourceProtocols.set(game, protocol);
}

export function deliverResources(game, runtime) {
  if ((resourceProtocols.get(game) || 0) < 2) {
    return;
  }
  const size = runtime.runtime_resource_mailbox();
  const capacity = game.game_resource_mailbox_capacity();
  const offset = game.game_resource_mailbox() >>> 0;
  const memory = game.memory.buffer;
  if (
    size <
      ((resourceProtocols.get(game) || 0) >= 3
        ? resourceSchema.mailboxPayloadOffset
        : resourceSchema.legacyMailboxPayloadOffset) ||
    size > capacity ||
    offset > memory.byteLength - size
  ) {
    throw new Error("Completion mailbox outside guest memory.");
  }
  new Uint8Array(memory, offset, size).set(
    new Uint8Array(runtime.memory.buffer, runtime.runtime_resource_packet(), size),
  );
  if (game.game_resource_mailbox_size(size) !== 1) {
    throw new Error("Completion mailbox rejected.");
  }
}

export function submitResources(game, runtime) {
  if (!resourceProtocols.has(game)) {
    return;
  }
  const offset = game.game_commit() >>> 0;
  checkExecutor(game);
  const size = game.game_commit_size() >>> 0;
  const memory = game.memory.buffer;
  if (
    size < 64 ||
    size > runtime.runtime_resource_capacity() ||
    offset > memory.byteLength - size
  ) {
    throw new Error("Resource packet outside guest memory or capacity.");
  }
  // No guest calls between snapshot and validation. Reacquire runtime memory after
  // each Odin call because allocation can grow it.
  const source = new Uint8Array(memory, offset, size);
  const sequence = new DataView(memory, offset, size).getUint32(28, true);
  const destination = runtime.runtime_resource_packet() >>> 0;
  new Uint8Array(runtime.memory.buffer, destination, size).set(source);
  if (runtime.runtime_resource_submit(size) !== 1) {
    const start = runtime.runtime_resource_error() >>> 0;
    const length = runtime.runtime_resource_error_size() >>> 0;
    const message = new TextDecoder().decode(new Uint8Array(runtime.memory.buffer, start, length));
    throw new Error(`Resource command ${runtime.runtime_resource_error_command()}: ${message}`);
  }
  if (game.game_commit_ack(sequence) !== 1) {
    throw new Error("Resource acknowledgement rejected.");
  }
  checkExecutor(game);
}

export function inspectGuest(bytes, compiledModule, { luauExecutor = false } = {}) {
  const memoryLimit = luauExecutor ? MAX_LUAU_MEMORY_BYTES : MAX_MEMORY_BYTES;
  const data = new Uint8Array(bytes);
  if (data.length > MAX_GAME_BYTES) {
    throw new Error("Game module exceeds prototype size limit.");
  }
  if (data.length < 8 || data.slice(0, 8).some((v, i) => v !== [0, 97, 115, 109, 1, 0, 0, 0][i])) {
    throw new Error("Invalid Wasm game header.");
  }
  let cursor = 8;
  function leb(end) {
    let value = 0,
      shift = 0;
    for (let i = 0; i < 5; i++) {
      if (cursor >= end) {
        throw new Error("Truncated Wasm section.");
      }
      const byte = data[cursor++];
      if (i === 4 && byte > 15) {
        throw new Error("Invalid Wasm integer.");
      }
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) {
        return value;
      }
      shift += 7;
    }
    throw new Error("Invalid Wasm integer.");
  }
  let hasMemory = false;
  const types = [],
    functions = [],
    functionExports = new Map();
  function name(end) {
    const size = leb(end);
    if (cursor + size > end) {
      throw new Error("Truncated Wasm name.");
    }
    const result = new TextDecoder("utf-8", { fatal: true }).decode(
      data.subarray(cursor, cursor + size),
    );
    cursor += size;
    return result;
  }
  function vector(end) {
    const count = leb(end);
    if (cursor + count > end) {
      throw new Error("Truncated Wasm type.");
    }
    const values = [...data.subarray(cursor, cursor + count)];
    cursor += count;
    return values;
  }
  while (cursor < data.length) {
    const section = data[cursor++];
    const size = leb(data.length);
    const end = cursor + size;
    if (end > data.length) {
      throw new Error("Truncated Wasm section.");
    }
    if (section === 1) {
      const count = leb(end);
      for (let i = 0; i < count; i++) {
        if (data[cursor++] !== 96) {
          throw new Error("Unsupported Wasm function type.");
        }
        types.push({ params: vector(end), results: vector(end) });
      }
    } else if (section === 2) {
      const count = leb(end);
      for (let i = 0; i < count; i++) {
        const module = name(end),
          field = name(end),
          kind = data[cursor++];
        const expected = {
          sin: { params: [124], results: [124] },
          content_size: { params: [127], results: [127] },
          content_read: { params: [127, 127, 127, 127], results: [127] },
          save_size: { params: [], results: [127] },
          save_status: { params: [], results: [127] },
          save_read: { params: [127, 127], results: [127] },
          save_write: { params: [127, 127], results: [127] },
          text_configure: { params: [127, 127], results: [127] },
          text_read: { params: [127, 127], results: [127] },
        }[field];
        if (kind !== 0 || module !== "env" || !expected) {
          throw new Error("Unsupported game import.");
        }
        const type = leb(end);
        if (JSON.stringify(types[type]) !== JSON.stringify(expected)) {
          throw new Error("Invalid game import signature.");
        }
        functions.push(type);
      }
    } else if (section === 3) {
      const count = leb(end);
      for (let i = 0; i < count; i++) {
        functions.push(leb(end));
      }
    } else if (section === 7) {
      const count = leb(end);
      for (let i = 0; i < count; i++) {
        const field = name(end),
          kind = data[cursor++],
          index = leb(end);
        if (kind === 0) {
          functionExports.set(field, index);
        }
      }
    } else if (section === 5) {
      if (hasMemory || leb(end) !== 1) {
        throw new Error("Game must define one memory.");
      }
      const flags = leb(end),
        initial = leb(end),
        maximum = flags === 1 ? leb(end) : Infinity;
      if (flags !== 1 || initial > maximum || maximum > memoryLimit / WASM_PAGE_BYTES) {
        throw new Error(
          `Game memory must declare a ${memoryLimit / (1024 * 1024)} MiB maximum or less.`,
        );
      }
      if (cursor !== end) {
        throw new Error("Invalid memory declaration.");
      }
      hasMemory = true;
    }
    cursor = end;
  }
  if (!hasMemory) {
    throw new Error("Game must define bounded memory.");
  }
  const module = compiledModule || new WebAssembly.Module(data);
  for (const item of WebAssembly.Module.imports(module)) {
    if (
      item.module !== "env" ||
      ![
        "sin",
        "content_size",
        "content_read",
        "save_size",
        "save_status",
        "save_read",
        "save_write",
        "text_configure",
        "text_read",
      ].includes(item.name) ||
      item.kind !== "function"
    ) {
      throw new Error("Unsupported game import.");
    }
  }
  const exports = new Map(WebAssembly.Module.exports(module).map((item) => [item.name, item.kind]));
  for (const signature of RESOURCE_EXPORTS) {
    if (!functionExports.has(signature.name)) {
      continue;
    }
    const actual = types[functions[functionExports.get(signature.name)]];
    if (
      !actual ||
      JSON.stringify(actual) !==
        JSON.stringify({ params: signature.params, results: signature.results })
    ) {
      throw new Error(`Invalid resource profile export signature: ${signature.name}.`);
    }
  }
  for (const name of ["game_abi", "game_frame_size", "game_init", "game_update", "game_draw"]) {
    if (exports.get(name) !== "function") {
      throw new Error(`Missing game export: ${name}.`);
    }
  }
  if (exports.get("memory") !== "memory") {
    throw new Error("Game must export memory.");
  }
  return module;
}

export function readFrame(game) {
  const offset = game.game_draw();
  checkExecutor(game);
  const memory = game.memory.buffer;
  if (!Number.isInteger(offset) || offset < 0 || offset > memory.byteLength - FRAME_BYTES) {
    throw new Error("Frame offset outside guest memory.");
  }
  const bytes = new Uint8Array(memory, offset, FRAME_BYTES).slice();
  const view = new DataView(memory, offset, FRAME_BYTES);
  return {
    bytes,
    ticks: view.getUint32(16, true),
    sounds: view.getUint32(20, true),
    spriteX: view.getInt32(8, true),
    spriteY: view.getInt32(12, true),
    x: view.getFloat64(24, true),
    y: view.getFloat64(32, true),
  };
}

export function checkExecutor(game) {
  if (!game.game_error_length) {
    return;
  }
  const length = game.game_error_length();
  if (!Number.isInteger(length) || length < 0 || length > 1024) {
    throw new Error("Invalid executor diagnostic.");
  }
  if (!length) {
    return;
  }
  const offset = game.game_error();
  if (!Number.isInteger(offset) || offset < 0 || offset > game.memory.buffer.byteLength - length) {
    throw new Error("Executor diagnostic outside memory.");
  }
  throw new Error(new TextDecoder().decode(new Uint8Array(game.memory.buffer, offset, length)));
}

export function loadSource(game, source) {
  const bytes = new Uint8Array(source);
  if (
    !bytes.length ||
    bytes.length > MAX_LUAU_SOURCE_BYTES ||
    typeof game.game_source_buffer !== "function" ||
    typeof game.game_source_capacity !== "function" ||
    typeof game.game_source_size !== "function"
  ) {
    throw new Error("Invalid source or executor.");
  }
  const allocate = typeof game.game_source_allocate === "function";
  const offset = allocate ? game.game_source_allocate(bytes.length) : game.game_source_buffer(),
    capacity = game.game_source_capacity();
  if (allocate && !offset) {
    checkExecutor(game);
    throw new Error("Cannot allocate source buffer.");
  }
  if (
    bytes.length > capacity ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > game.memory.buffer.byteLength - bytes.length
  ) {
    throw new Error("Source outside executor memory.");
  }
  new Uint8Array(game.memory.buffer, offset, bytes.length).set(bytes);
  game.game_source_size(bytes.length);
}

function blob(game, offsetName, sizeName, limit) {
  if (typeof game[offsetName] !== "function" || typeof game[sizeName] !== "function") {
    throw new Error("Missing guest buffer exports.");
  }
  const size = game[sizeName](),
    offset = game[offsetName]();
  if (
    !Number.isInteger(size) ||
    size < 0 ||
    size > limit ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > game.memory.buffer.byteLength - size
  ) {
    throw new Error("Guest buffer outside memory.");
  }
  return new Uint8Array(game.memory.buffer, offset, size);
}
export function uploadGraphics(game, runtime) {
  if (!game.game_assets) {
    return;
  }
  const bytes = blob(game, "game_assets", "game_assets_size", 16 + 64 + 256 * 256 + 128 * 7);
  new Uint8Array(runtime.memory.buffer, runtime.runtime_assets(), bytes.length).set(bytes);
  if (runtime.runtime_load_graphics(bytes.length) !== 1) {
    throw new Error("Invalid graphics assets.");
  }
}
export function displayMode(game) {
  const mode = game.game_display_mode?.() ?? (640 << DISPLAY_DIMENSION_BITS) | 360;
  if (
    mode !== ((640 << DISPLAY_DIMENSION_BITS) | 360) &&
    mode !== ((320 << DISPLAY_DIMENSION_BITS) | 180)
  ) {
    throw new Error("Unsupported display mode.");
  }
  return {
    mode,
    width: mode >>> DISPLAY_DIMENSION_BITS,
    height: mode & DISPLAY_DIMENSION_MASK,
  };
}
export function submitDrawing(game, runtime) {
  const record = readFrame(game);
  const display = displayMode(game);
  if (runtime.runtime_display(display.mode) !== 1) {
    throw new Error("Unsupported display mode.");
  }
  new Uint8Array(runtime.memory.buffer, runtime.runtime_frame(), FRAME_BYTES).set(record.bytes);
  let count = 0,
    stride = 20,
    textSize = 0;
  if (game.game_commands) {
    stride = game.game_command_stride?.() ?? 20;
    if (stride !== 20 && stride !== 32) {
      throw new Error("Unsupported command stride.");
    }
    const offset = game.game_commands();
    count = game.game_command_count();
    if (
      !Number.isInteger(count) ||
      count < 0 ||
      count > 16384 ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > game.memory.buffer.byteLength - count * stride
    ) {
      throw new Error("Invalid display list bounds.");
    }
    const target = stride === 32 ? runtime.runtime_batch() : runtime.runtime_commands();
    new Uint8Array(runtime.memory.buffer, target, count * stride).set(
      new Uint8Array(game.memory.buffer, offset, count * stride),
    );
    if (stride === 32) {
      const bytes = blob(game, "game_text", "game_text_size", 16384);
      textSize = bytes.length;
      new Uint8Array(runtime.memory.buffer, runtime.runtime_text(), textSize).set(bytes);
    }
  }
  if ((resourceProtocols.get(game) || 0) >= 2) {
    submitResources(game, runtime);
  }
  return { record, count, stride, textSize, ...display };
}
export function rasterizeDrawing(runtime, { count, stride, textSize }) {
  if (runtime.runtime_render() !== 1) {
    throw new Error("Invalid frame command.");
  }
  const valid =
    stride === 32
      ? runtime.runtime_render_batch(count, textSize)
      : runtime.runtime_render_commands(count);
  if (valid !== 1) {
    throw new Error("Invalid display list command.");
  }
}
