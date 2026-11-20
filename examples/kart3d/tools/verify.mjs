import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "../../../tools/browser-timing.mjs";
import { buildKart3d, root } from "./build.mjs";
import { course, LAP_UNITS } from "./course.mjs";
import { run, nativePlayer } from "../../../tools/toolchain.mjs";
import { odinUnitTests } from "../../../tools/odin-unit-tests.mjs";
import { serve } from "../../../tools/serve.mjs";
import * as policy from "../../../runtime/odin/web/policy.js";
import { contentImports, decodeCartridge } from "../../../runtime/odin/web/cartridge.js";
import { chunks, chunk, signature, encodeContent } from "../../../tools/sdk/cartridge.mjs";
import {
  MAX_LUAU_SOURCE_BYTES,
  MAX_CONTENT_READ_BYTES,
  CONTENT_HEADER_BYTES,
  CONTENT_HEADER_COUNT,
  CONTENT_RECORD_BYTES,
  CONTENT_RECORD_ID,
  CONTENT_RECORD_OFFSET,
  CONTENT_RECORD_LENGTH,
} from "../../../runtime/odin/web/constants.js";

const gpu = process.argv.includes("--gpu");
const output = resolve("examples/kart3d/build/validation", randomUUID());
await mkdir(output, { recursive: true });
odinUnitTests("examples/kart3d/tests", resolve(output, "race.exe"));
const projects = await buildKart3d();
const imports = {
  env: {
    sin: Math.sin,
    content_size: () => 0,
    content_read: () => 0,
    save_size: () => 0,
    save_status: () => 3,
    save_read: () => 0,
    save_write: () => 3,
    text_configure: () => 0,
    text_read: () => 0,
  },
};
async function pair(language, source, cartridge) {
  const base = resolve(root, language, "build/web");
  const runtime = (
    await WebAssembly.instantiate(await readFile(resolve(base, "runtime.wasm")), imports)
  ).instance.exports;
  decodeCartridge(runtime, cartridge || (await readFile(resolve(base, "game.png"))));
  let game = null;
  game = (
    await WebAssembly.instantiate(
      await readFile(resolve(base, language === "odin" ? "game.wasm" : "luau-executor.wasm")),
      { env: { ...imports.env, ...contentImports(runtime, () => game) } },
    )
  ).instance.exports;
  game._initialize?.();
  runtime.runtime_init();
  if (language === "luau") {
    policy.loadSource(game, source || (await readFile(resolve(base, "game.luau"))));
  }
  policy.configureResources(game, runtime);
  game.game_init();
  policy.checkExecutor(game);
  policy.submitResources(game, runtime);
  policy.uploadGraphics(game, runtime);
  return { game, runtime };
}
function step({ game, runtime }, mask) {
  policy.deliverResources(game, runtime);
  game.game_update(mask, 0, 0, 0);
  policy.checkExecutor(game);
  policy.submitResources(game, runtime);
}
function draw({ game, runtime }) {
  const frame = policy.submitDrawing(game, runtime);
  policy.rasterizeDrawing(runtime, frame);
  return {
    hash: runtime.runtime_hash() >>> 0,
    sounds: frame.record.sounds,
    width: frame.width,
    height: frame.height,
    x: frame.record.x,
    y: frame.record.y,
  };
}
const reference = await pair("odin");
const state = () =>
  Array.from(new Int32Array(reference.game.memory.buffer, reference.game.game_inspect(), 30));
const masks = [],
  samples = [],
  states = [];
const pilot = (s) => {
  const curve = course[Math.floor(s[2] / 1024) % 96][5];
  const desired = Math.max(-35, Math.min(35, -s[3] / 14));
  const correction = desired - s[4] + Math.floor((curve * s[5]) / 1024);
  let mask = 4 | (correction > 1 ? 2 : correction < -1 ? 1 : 0);
  if (s[14] && s[0] % 180 === 0) {
    mask |= 16384;
  }
  return mask;
};
function record(mask, force = false) {
  masks.push(mask);
  step(reference, mask);
  const s = state();
  const segment = Math.floor(s[2] / 1024) % course.length;
  const fraction = (s[2] % 1024) / 1024;
  const height =
    course[segment][1] + (course[(segment + 1) % course.length][1] - course[segment][1]) * fraction;
  assert.equal(s[26], Math.floor(height * 256), "kart follows interpolated course elevation");
  assert(s[28] >= 0 && s[28] <= 48, "fixed particle pool stays bounded");
  assert(s[29] >= 1 && s[29] <= 8, "LOD decisions include the player and at most eight karts");
  if (masks.length % 30 === 0 || force) {
    samples.push({ index: masks.length - 1, ...draw(reference) });
    states.push([masks.length, ...s]);
  }
}
while (state()[13] === 0 && masks.length < 6500) {
  record(pilot(state()));
}
assert.equal(state()[13], 1, "autodriver finishes all three laps");
const finished = state();
assert.equal(finished[12], 12, "ordered quarter-lap checkpoints");
assert(finished[2] >= LAP_UNITS * 3);
assert(finished[11] > 0, "collected items activated");
record(0, true);
record(8192, true);
record(0);
record(32768, true);
assert.equal(state()[2], 0, "restart resets course progress");
for (let i = 0; i < 340; i++) {
  record(pilot(state()));
}
for (let i = 0; i < 36; i++) {
  record(4 | 16 | (Math.floor(i / 6) % 2 === 0 ? 2 : 1), i % 6 === 0);
}
const charged = state();
assert.equal(charged[7], 2, "deliberate countersteering charges drift");
record(4, true);
assert(state()[11] > 0, "charged release awards mini-turbo");
assert(state()[28] > 0, "drift/boost emits scene-space effects");
for (let i = 0; i < 160; i++) {
  record(4 | 2);
}
assert(state()[10] > 0, "off-road handling exercised");
assert(state()[9] > 0, "wall or kart contacts exercised");
for (let i = 0; i < 60; i++) {
  record(8);
}
assert.equal(state()[5], 0, "braking stops the kart");
record(32768, true);
assert.equal(state()[28], 0, "restart clears live particles");
for (const expected of [1, 2, 0]) {
  record(0);
  record(8192 | 16, true);
  assert.equal(state()[27], expected, "Space+Q cycles low/high/automatic detail");
}
const input = resolve(output, "race.inputs");
await writeFile(input, masks.join("\n") + "\n");
await writeFile(
  resolve(output, "samples.json"),
  JSON.stringify({ masks, samples, states }, null, 2),
);

// The development-only Luau wrapper checks internal state against sampled Odin
// state without changing the shipping cartridge or requiring a new console ABI.
const fields = [
  "tick",
  "elapsed",
  "distance",
  "lateral",
  "heading",
  "speed",
  "drift",
  "charge",
  "boost",
  "hits",
  "offroad",
  "boosts",
  "checkpoint",
  "finished",
  "item",
  "events",
  "rivals[1]",
  "hop",
  "switches",
  "pickup",
  ...Array.from({ length: 6 }, (_, i) => `rivals[${i + 2}]`),
];
const stateExpressions = [
  ...fields.map((field) => `s.${field}`),
  "math.floor(scene.sample(s.distance,s.lateral)[2]*256)",
  "polish.inspect()[1]",
  "polish.inspect()[2]",
  "polish.inspect()[3]",
];
const original = await readFile(resolve(root, "luau/build/web/game.luau"), "utf8");
assert.ok(
  Buffer.byteLength(original) <= MAX_LUAU_SOURCE_BYTES,
  "shipping source fits its unchanged budget",
);
// Bundle source contains the authored game module; instrument its unique return.
const needle = "return { init = init, update = update, draw = draw }";
assert.equal(original.split(needle).length, 2, "one game lifecycle return");
// Store every sampled state as exact integer deltas in verification-only content.
// Replay data must not consume the shipping cartridge's source-code budget.
let previousState = Array(states[0].length).fill(0);
const checks = states
  .map((row) => {
    const words = [row[0].toString(36)];
    for (let column = 1; column < row.length; column++) {
      if (row[column] !== previousState[column]) {
        words.push((column + 1).toString(36), (row[column] - previousState[column]).toString(36));
      }
    }
    previousState = row;
    return words.join(",");
  })
  .join("\n");
const expectationBytes = Buffer.from(checks);
assert.ok(
  expectationBytes.length <= MAX_CONTENT_READ_BYTES,
  "replay expectations fit one bounded content read",
);
await writeFile(resolve(output, "replay-expectations.bin"), expectationBytes);

// Preserve existing content IDs and bytes in the private verification cartridge.
const parts = chunks(await readFile(resolve(root, "luau/build/web/game.png")));
const entries = [];
for (const part of parts.filter((part) => part.type === "coNt")) {
  const count = part.data.readUInt32LE(CONTENT_HEADER_COUNT);
  const payload = CONTENT_HEADER_BYTES + count * CONTENT_RECORD_BYTES;
  for (let index = 0; index < count; index++) {
    const record = CONTENT_HEADER_BYTES + index * CONTENT_RECORD_BYTES;
    const id = part.data.readUInt32LE(record + CONTENT_RECORD_ID);
    const offset = part.data.readUInt32LE(record + CONTENT_RECORD_OFFSET);
    const length = part.data.readUInt32LE(record + CONTENT_RECORD_LENGTH);
    entries.push({ id, bytes: part.data.subarray(payload + offset, payload + offset + length) });
  }
}
let expectationId = 1;
while (entries.some((entry) => entry.id === expectationId)) {
  expectationId++;
}
const verificationContent = encodeContent([
  ...entries,
  { id: expectationId, bytes: expectationBytes },
]);
const verificationCartridge = Buffer.concat([
  signature,
  ...parts
    .filter((part) => part.type !== "coNt")
    .flatMap((part) => [
      ...(part.type === "IEND" ? [chunk("coNt", verificationContent)] : []),
      chunk(part.type, part.data),
    ]),
]);
await writeFile(resolve(output, "verification.png"), verificationCartridge);
const wrapper = `local function loadChecks()
    local size = byt.content.size(${expectationId})
    assert(size == ${expectationBytes.length}, "complete replay expectations content")
    local bytes = buffer.create(size)
    assert(byt.content.read(${expectationId}, 0, bytes), "bounded replay expectations read")
    local checks = string.split(buffer.tostring(bytes), "\\n")
    assert(#checks == ${states.length}, "every replay expectation is present")
    return checks
end
local checks = loadChecks()
local checkIndex, verificationTick = 1, 0
local previous = table.create(${stateExpressions.length + 1}, 0)
local function decodeWord(word: string)
    local sign = 1
    if string.sub(word, 1, 1) == "-" then
        sign = -1
        word = string.sub(word, 2)
    end
    local value = tonumber(word, 36)
    assert(value ~= nil, "invalid replay expectation")
    return value * sign
end
local function expectedAt(index: number)
    local encoded = checks[index]
    if not encoded then return nil end
    local words = string.gmatch(encoded, "[^,]+")
    local result = table.clone(previous)
    local tick = words()
    assert(tick ~= nil, "missing replay tick")
    result[1] = decodeWord(tick)
    while true do
        local columnWord = words()
        if not columnWord then break end
        local delta = words()
        assert(delta ~= nil, "missing replay delta")
        local column = decodeWord(columnWord)
        assert(column >= 2 and column <= #result, "invalid replay column")
        result[column] += decodeWord(delta)
    end
    previous = result
    return result
end
local expected = expectedAt(checkIndex)
local function verifiedUpdate(dt: number)
    update(dt)
    verificationTick += 1
    if expected and expected[1] == verificationTick then
        local actual = {${stateExpressions.join(",")}}
        for i, value in actual do
            assert(value == expected[i+1], "racing state mismatch " .. verificationTick .. "/" .. i)
        end
        checkIndex += 1
        expected = expectedAt(checkIndex)
    end
    if verificationTick == ${masks.length} then
        assert(expected == nil and checkIndex == #checks + 1, "every replay expectation was checked")
    end
end
return {init=init,update=verifiedUpdate,draw=draw}`;
const verifiedSource = Buffer.from(original.replace(needle, wrapper));
assert.ok(
  verifiedSource.length <= MAX_LUAU_SOURCE_BYTES,
  `instrumented replay (${verifiedSource.length} bytes) fits the ${MAX_LUAU_SOURCE_BYTES}-byte Luau source budget`,
);
await writeFile(resolve(output, "verified.luau"), verifiedSource);
console.log(
  `Kart replay source: production ${Buffer.byteLength(original)}, instrumented ${verifiedSource.length}, expectations ${expectationBytes.length} bytes (${states.length} snapshots).`,
);
const luau = await pair("luau", verifiedSource, verificationCartridge);
for (const entry of entries) {
  assert.equal(luau.runtime.runtime_content_size(entry.id), entry.bytes.length);
  assert.deepEqual(
    new Uint8Array(
      luau.runtime.memory.buffer,
      luau.runtime.runtime_content_pointer(entry.id),
      entry.bytes.length,
    ),
    new Uint8Array(entry.bytes),
    "verification content preserves every production entry",
  );
}
let sampleIndex = 0;
for (let i = 0; i < masks.length; i++) {
  step(luau, masks[i]);
  if (samples[sampleIndex]?.index === i) {
    const actual = draw(luau),
      expected = samples[sampleIndex++];
    assert.equal(actual.hash, expected.hash, `CPU SDK pixels at ${i}`);
    assert.equal(actual.sounds, expected.sounds);
    assert.equal(actual.x, expected.x);
    assert.equal(actual.y, expected.y);
  }
}
assert.equal(sampleIndex, samples.length);
// Exercise the three-sample resolve where a custom shadow matrix previously
// reached multiplication as doubles in Luau but f32 values in Odin.
const qualityHashes = [];
for (const language of ["odin", "luau"]) {
  const instance = await pair(language);
  assert.equal(instance.runtime.runtime_cpu_configure(6, 0, 0), 1);
  for (const [index, mask] of masks.slice(0, 245).entries()) {
    step(instance, mask | (index === 0 ? 8192 : 0));
  }
  const image = draw(instance);
  assert.deepEqual([image.width, image.height], [640, 360]);
  qualityHashes.push(image.hash);
  instance.runtime.runtime_resource_close();
}
assert.equal(qualityHashes[0], qualityHashes[1], "640x360 / 1080p shadow composition SDK pixels");
const pixels = new Uint32Array(
  reference.runtime.memory.buffer,
  reference.runtime.runtime_pixels(),
  640 * 360,
);
assert(pixels.filter((pixel) => pixel === 0xfff5f3ed).length > 30, "visible white HUD glyphs");

const report = {
  status: "running",
  gpu,
  finished,
  frames: masks.length,
  snapshots: samples.length,
  cases: [],
};
const server = serve(".", 0);
await once(server, "listening");
const browser = await chromium.launch({
  channel: process.env.PLAYER_BROWSER_CHANNEL || "chrome",
});
const imageIndices = samples.filter((_, i) => i % 13 === 0).map((x) => x.index);
for (const sample of samples) {
  if (sample.width === 640 && imageIndices.length < 14) {
    imageIndices.push(sample.index);
  }
}
const gpuReferences = {};
try {
  const page = await browser.newPage();
  for (const { language, project } of projects) {
    const base = "/" + relative(process.cwd(), resolve(project, "build/web")).replaceAll("\\", "/");
    await page.goto(`http://127.0.0.1:${server.address().port}${base}/player.html`);
    const backend = gpu ? "gpu" : "cpu";
    const native = run(
      resolve(project, `build/native/${nativePlayer}`),
      ["--replay", input, "--renderer", backend, ...(gpu ? ["--gpu-meshes"] : [])],
      { env: { ...process.env, ...(!gpu ? { SDL_VIDEODRIVER: "dummy" } : {}) } },
    )
      .trim()
      .split(/\r?\n/)
      .map(JSON.parse);
    assert.equal(native.length, masks.length);
    if (!gpu) {
      for (const expected of samples) {
        assert.equal(native[expected.index].hash, expected.hash, `${language}: native CPU replay`);
      }
    }
    const web = await page.evaluate(
      async ({ base, masks, indices, imageIndices, gpu }) => {
        const worker = new Worker(base + "/worker.js", { type: "module" });
        const request = (message, type) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Kart worker deadline")), 120000);
            worker.onerror = (e) => {
              clearTimeout(timer);
              reject(new Error(e.message));
            };
            worker.onmessage = async ({ data }) => {
              if (data.type === "executor") {
                const bytes = await (await fetch(base + "/luau-executor.wasm")).arrayBuffer();
                worker.postMessage({ type: "executor", executor: { bytes } }, [bytes]);
              } else if (data.type === "error") {
                clearTimeout(timer);
                reject(new Error(data.error));
              } else if (data.type === type) {
                clearTimeout(timer);
                data.bitmap?.close();
                resolve(data);
              }
            };
            worker.postMessage(message);
          });
        try {
          const ready = await request(
            {
              type: "load",
              gameUrl: location.origin + base + "/game.png",
              graphics: { backend: gpu ? "gpu" : "cpu", residentMeshes: gpu },
            },
            "ready",
          );
          if (ready.graphics.effective !== (gpu ? "gpu" : "cpu")) {
            throw new Error("Wrong renderer");
          }
          const snapshots = [];
          const images = [];
          let next = 0;
          for (let i = 0; i < masks.length; i++) {
            const render = indices[next] === i;
            const frame = await request(
              {
                type: "step",
                steps: 1,
                render,
                input: { buttons: masks[i], pointer: false, x: 0, y: 0 },
              },
              render ? "frame" : "stepped",
            );
            if (render) {
              snapshots.push({
                index: i,
                hash: frame.hash,
                width: frame.width,
                height: frame.height,
                x: frame.x,
                y: frame.y,
              });
              if (gpu && imageIndices.includes(i)) {
                const capture = await request({ type: "capture" }, "capture");
                images.push({
                  index: i,
                  width: capture.width,
                  height: capture.height,
                  bytes: Array.from(new Uint8Array(capture.pixels)),
                });
              }
              next++;
            }
          }
          return { startup: ready.startup, memory: ready.memory, snapshots, images };
        } finally {
          worker.terminate();
        }
      },
      { base, masks, indices: samples.map((x) => x.index), imageIndices, gpu },
    );
    for (const frame of web.snapshots) {
      if (!gpu) {
        assert.equal(
          frame.hash,
          native[frame.index].hash,
          `${language}/${backend}: native/browser output`,
        );
      }
      const expected = samples.find((s) => s.index === frame.index);
      assert.equal(frame.x, expected.x);
      assert.equal(frame.y, expected.y);
    }
    const differences = [];
    if (gpu) {
      const traces = web.snapshots.map((x) => x.hash);
      if (gpuReferences.native) {
        assert.deepEqual(native, gpuReferences.native);
        assert.deepEqual(traces, gpuReferences.browser);
      } else {
        gpuReferences.native = native;
        gpuReferences.browser = traces;
      }
      for (const image of web.images) {
        const prefix = resolve(output, `${language}-${image.index}`);
        await writeFile(prefix + ".inputs", masks.slice(0, image.index + 1).join("\n") + "\n");
        run(resolve(project, `build/native/${nativePlayer}`), [
          "--replay",
          prefix + ".inputs",
          "--renderer",
          "gpu",
          "--gpu-meshes",
          "--capture-rgba",
          prefix + ".rgba",
        ]);
        const bytes = await readFile(prefix + ".rgba");
        await writeFile(prefix + "-web.rgba", new Uint8Array(image.bytes));
        assert.equal(bytes.length, image.bytes.length);
        let changed = 0,
          significant = 0,
          squared = 0,
          maxDelta = 0;
        for (let i = 0; i < bytes.length; i += 4) {
          let peak = 0;
          for (let c = 0; c < 3; c++) {
            const d = Math.abs(bytes[i + c] - image.bytes[i + c]);
            peak = Math.max(peak, d);
            squared += d * d;
          }
          if (peak > 0) {
            changed++;
          }
          if (peak > 2) {
            significant++;
          }
          maxDelta = Math.max(maxDelta, peak);
        }
        const count = bytes.length / 4,
          rms = Math.sqrt(squared / (count * 3));
        const difference = { index: image.index, changed, significant, maxDelta, rms };
        differences.push(difference);
        console.log(`${language}/gpu pixels: ${JSON.stringify(difference)}`);
        assert(significant / count <= 0.001, "GPU material differences stay below 0.1% of pixels");
        assert(rms <= 2, "GPU RGB RMS stays below two 8-bit levels");
      }
    }
    delete web.images;
    assert(
      web.snapshots.some((x) => x.width === 320) && web.snapshots.some((x) => x.width === 640),
    );
    report.cases.push({
      language,
      backend,
      cartridgeBytes: (await readFile(resolve(project, "build/game.png"))).length,
      ...web,
      differences,
    });
    console.log(
      `${language}/${backend}: ${masks.length} updates, ${samples.length} native/browser snapshots passed`,
    );
  }
  report.status = "passed";
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(`Kart validation: ${relative(process.cwd(), output)}`);
