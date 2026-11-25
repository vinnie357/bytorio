import assert from "node:assert/strict";

const wasmPageBytes = 65536;

function unsignedLeb(value) {
  const bytes = [];
  do {
    const remaining = Math.floor(value / 128);
    bytes.push((value % 128) | (remaining ? 128 : 0));
    value = remaining;
  } while (value);
  return bytes;
}

function section(id, data) {
  return [id, ...unsignedLeb(data.length), ...data];
}

export function moduleWithMemory(maximumPages) {
  const exports = [
    ["memory", 2, 0],
    ["game_abi", 0, 0],
    ["game_frame_size", 0, 1],
    ["game_init", 0, 2],
    ["game_update", 0, 3],
    ["game_draw", 0, 4],
  ];
  const abiBody = [0, 0x41, 1, 0x0b];
  const frameSizeBody = [0, 0x41, 40, 0x0b];
  const body = [0, 0x41, 0, 0x0b];
  return Uint8Array.from([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(1, [3, 0x60, 0, 1, 0x7f, 0x60, 0, 0, 0x60, 4, 0x7f, 0x7f, 0x7c, 0x7c, 0]),
    ...section(3, [5, 0, 0, 1, 2, 0]),
    ...section(5, [1, 1, 1, ...unsignedLeb(maximumPages)]),
    ...section(7, [
      exports.length,
      ...exports.flatMap(([name, kind, index]) => [name.length, ...Buffer.from(name), kind, index]),
    ]),
    ...section(10, [
      5,
      abiBody.length,
      ...abiBody,
      frameSizeBody.length,
      ...frameSizeBody,
      2,
      0,
      0x0b,
      2,
      0,
      0x0b,
      body.length,
      ...body,
    ]),
  ]);
}

export function declaredMemoryMaximum(bytes) {
  const module = new WebAssembly.Module(bytes);
  assert.ok(
    WebAssembly.Module.exports(module).some(
      ({ name, kind }) => name === "memory" && kind === "memory",
    ),
  );
  let cursor = 8;
  function readLeb(end) {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      assert.ok(cursor < end, "truncated Wasm integer");
      const byte = bytes[cursor++];
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) {
        return value;
      }
    }
    assert.fail("invalid Wasm integer");
  }
  while (cursor < bytes.length) {
    const id = bytes[cursor++];
    const size = readLeb(bytes.length);
    const end = cursor + size;
    assert.ok(end <= bytes.length, "truncated Wasm section");
    if (id === 5) {
      assert.equal(readLeb(end), 1, "executor defines one memory");
      assert.equal(readLeb(end), 1, "executor memory is unshared, 32-bit and bounded");
      const initialPages = readLeb(end);
      const maximumPages = readLeb(end);
      assert.ok(initialPages <= maximumPages);
      assert.equal(cursor, end);
      return maximumPages * wasmPageBytes;
    }
    cursor = end;
  }
  assert.fail("missing Wasm memory section");
}
