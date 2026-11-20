import { FNV1A_OFFSET_BASIS, FNV1A_PRIME } from "../runtime/odin/web/constants.js";
import assert from "node:assert/strict";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { timedSpawnSync as spawnSync } from "./command-timing.mjs";
import { once } from "node:events";
import { chromium } from "./browser-timing.mjs";
import { createProject, buildProject } from "./sdk/project.mjs";
import { serve } from "./serve.mjs";
import { tool, task, copyWasmtimeLibrary, nativePlayer } from "./toolchain.mjs";
import {
  configureResources,
  submitResources,
  loadSource,
  checkExecutor,
} from "../runtime/odin/web/policy.js";

const schema = JSON.parse(await readFile("sdk/resource-protocol.json", "utf8"));
assert.equal(schema.magic, Buffer.from("AVP1").readUInt32LE());

const root = resolve("build/resource-verification", randomUUID());
await mkdir(root, { recursive: true });
await writeFile(resolve(root, "harness.html"), "<!doctype html><title>Resource verifier</title>\n");
function run(exe, args) {
  const result = spawnSync(exe, args, { encoding: "utf8", timeout: 120000 });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  return result.stdout;
}
run(process.execPath, ["tools/generate-constants.mjs", "--check"]);
const odin = tool("odin");
run(odin, ["test", "tests/resources", "-o:none", `-out:${resolve(root, "registry-tests.exe")}`]);
task("deps:trace:resources");
await copyFile("build/validation-tools/resources/trace.exe", resolve(root, "trace.exe"));
await copyWasmtimeLibrary(root);
const projects = {};
let reference;
function validateInitialPacket(game, runtime) {
  const offset = game.game_commit() >>> 0;
  const size = game.game_commit_size();
  const packet = new Uint8Array(game.memory.buffer, offset, size).slice();
  const header = new DataView(packet.buffer);
  const expectedHeader = {
    magic: schema.magic,
    abi: 2,
    headerBytes: 64,
    session: 1,
    tick: 0n,
    phase: 0,
    sequence: 1,
    count: 4,
    commandsOffset: 64,
    commandsBytes: 128,
    payloadOffset: 192,
    payloadBytes: size - 192,
  };
  for (const [field, at] of Object.entries(schema.header)) {
    assert.equal(
      field === "tick" ? header.getBigUint64(at, true) : header.getUint32(at, true),
      expectedHeader[field],
      `schema header ${field}`,
    );
  }
  const expectedCommands = [
    ["create_texture", 65537, { format: 2, width: 2, height: 2 }],
    ["write_texture", 65537, { x: 0, y: 0, width: 2, height: 2, offsetBytes: 0, strideBytes: 8 }],
    ["create_sample", 65538, { format: 3, frames: 4, channels: 2, rate: 48000 }],
    ["write_sample", 65538, { firstFrame: 0, frames: 4 }],
  ];
  expectedCommands.forEach(([op, id, values], index) => {
    const start = schema.headerBytes + index * schema.commandBytes;
    const fields = schema.command;
    assert.equal(header.getUint16(start + fields.opcode, true), schema.opcodes[op]);
    assert.equal(header.getUint16(start + fields.recordBytes, true), schema.commandBytes);
    assert.equal(header.getUint32(start + fields.id, true), id);
    assert.equal(header.getUint32(start + fields.flags, true), 0);
    assert.equal(header.getUint32(start + fields.reserved, true), 0);
    assert.equal(header.getUint32(start + fields.argsBytes, true), schema.descriptorBytes);
    const args = expectedHeader.payloadOffset + header.getUint32(start + fields.argsOffset, true);
    schema.descriptor[op].forEach((field, i) =>
      assert.equal(
        header.getUint32(args + i * 4, true),
        field === "reserved" ? 0 : values[field],
        `schema ${op}.${field}`,
      ),
    );
  });
  const payload = header.getUint32(44, true);
  const last = 64 + (header.getUint32(32, true) - 1) * 32;
  const dataAt = payload + header.getUint32(last + 20, true);
  const textureData = payload + header.getUint32(96 + 20, true);
  const initialHash = runtime.runtime_resource_hash() >>> 0;
  const mutations = [
    ["count overflow", (v) => v.setUint32(32, 0xffffffff, true)],
    ["header overlap", (v) => v.setUint32(44, 0, true)],
    ["unknown header flags", (v) => v.setUint32(52, 1, true)],
    ["stale session", (v) => v.setUint32(12, 0, true)],
    ["stale generation", (v) => v.setUint32(72, 0x20001, true)],
    ["later command fails after valid creates/writes", (v) => v.setUint16(last, 999, true)],
    ["wrong resource kind", (v) => v.setUint16(96, 4, true)],
    ["argument offset overflow", (v) => v.setUint32(76, 0xfffffffc, true)],
    ["argument size mismatch", (v) => v.setUint32(80, 28, true)],
    [
      "upload offset overflow",
      (v) => v.setUint32(payload + header.getUint32(108, true) + 16, 0xffffffff, true),
    ],
    ["data offset overflow", (v) => v.setUint32(last + 20, 0xffffffff, true)],
    ["PCM NaN", (v) => v.setUint32(dataAt, 0x7fc00000, true)],
    ["non-premultiplied RGBA", (v) => v.setUint8(textureData + 3, 0)],
  ];
  for (const [label, mutate] of mutations) {
    const bad = packet.slice();
    mutate(new DataView(bad.buffer));
    new Uint8Array(runtime.memory.buffer, runtime.runtime_resource_packet(), size).set(bad);
    assert.equal(runtime.runtime_resource_submit(size), 0, label);
    assert.equal(
      runtime.runtime_resource_hash() >>> 0,
      initialHash,
      `${label}: no partial publication`,
    );
    assert.equal(runtime.runtime_resource_bytes(), 0, `${label}: no retained allocations`);
  }
  new Uint8Array(runtime.memory.buffer, runtime.runtime_resource_packet(), size).set(packet);
  assert.equal(runtime.runtime_resource_submit(size), 1);
  assert.equal(game.game_commit_ack(header.getUint32(28, true)), 1);
}
for (const language of ["odin", "luau"]) {
  const project = resolve(root, language);
  await createProject(project, language);
  await copyFile(
    `examples/resources/lifecycle/${language}/main.${language}`,
    resolve(project, `src/main.${language}`),
  );
  await buildProject(project);
  projects[language] = project;
  const base = resolve(project, "build/web");
  const wasm = resolve(base, language === "luau" ? "luau-executor.wasm" : "game.wasm");
  const source = language === "luau" ? resolve(base, "game.luau") : null;
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
  const game = (await WebAssembly.instantiate(await readFile(wasm), imports)).instance.exports;
  assert.deepEqual(
    WebAssembly.Module.imports(new WebAssembly.Module(await readFile(wasm))),
    language === "luau"
      ? [
          { module: "env", name: "content_size", kind: "function" },
          { module: "env", name: "content_read", kind: "function" },
          { module: "env", name: "save_size", kind: "function" },
          { module: "env", name: "save_status", kind: "function" },
          { module: "env", name: "save_read", kind: "function" },
          { module: "env", name: "text_configure", kind: "function" },
          { module: "env", name: "text_read", kind: "function" },
          { module: "env", name: "save_write", kind: "function" },
        ]
      : [],
  );
  const runtime = (
    await WebAssembly.instantiate(await readFile(resolve(base, "runtime.wasm")), imports)
  ).instance.exports;
  game._initialize?.();
  if (source) {
    loadSource(game, await readFile(source));
  }
  configureResources(game, runtime);
  game.game_init();
  checkExecutor(game);
  validateInitialPacket(game, runtime);
  const trace = [[runtime.runtime_resource_hash() >>> 0, runtime.runtime_resource_bytes()]];
  for (let tick = 1; tick <= 120; tick++) {
    game.game_update(0, 0, 0, 0);
    checkExecutor(game);
    submitResources(game, runtime);
    if (tick % 4 === 0) {
      game.game_draw();
    }
    trace.push([runtime.runtime_resource_hash() >>> 0, runtime.runtime_resource_bytes()]);
  }
  assert.equal(trace[0][1], 48);
  // Independent expected bytes prove both SDKs did not merely share a copy bug.
  const expected = [];
  function expectedSlot(fields, bytes) {
    const metadata = new Uint8Array(fields.length * 4);
    fields.forEach((value, i) => new DataView(metadata.buffer).setUint32(i * 4, value, true));
    expected.push(...metadata, ...bytes);
  }
  expectedSlot([65537, 1, 2, 2, 2, 0, 0], new Uint8Array(16).fill(255));
  const samples = new Uint8Array(32);
  new DataView(samples.buffer).setFloat32(0, 0.25, true);
  new DataView(samples.buffer).setFloat32(4, -0.25, true);
  expectedSlot([65538, 2, 3, 4, 0, 2, 48000], samples);
  assert.equal(
    trace[0][0],
    expected.reduce((hash, byte) => Math.imul(hash ^ byte, FNV1A_PRIME) >>> 0, FNV1A_OFFSET_BASIS),
  );
  assert.notEqual(trace[2][0], trace[0][0], "texture edit changes owned bytes");
  assert.notEqual(trace[3][0], trace[2][0], "PCM edit changes owned bytes");
  assert.equal(trace[4][1], 0);
  assert.equal(trace[5][1], 3);
  if (reference) {
    assert.deepEqual(trace, reference, "SDK traces agree");
  } else {
    reference = trace;
  }
  const native = run(resolve(root, "trace.exe"), [wasm, ...(source ? [source] : [])])
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(" ").map(Number));
  assert.deepEqual(
    native,
    trace,
    `${language} native and Wasm registry traces agree, including skipped draws`,
  );
  const rejected = spawnSync(resolve(root, "trace.exe"), [wasm, source || "", "fault"], {
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(rejected.status, 1);
  assert.match(
    rejected.stderr,
    /stale (?:resource )?generation/i,
    `${language} native SDK errors terminate before publishing`,
  );
  const standalone = JSON.parse(
    run(resolve(project, "build/native", nativePlayer), [
      "--check",
      "--game",
      wasm,
      ...(source ? ["--source", source] : []),
    ]),
  );
  assert.equal(standalone.resourceHash, trace[120][0]);
  assert.equal(standalone.resourceBytes, 3);
  // Reconfiguration resets registry/session, rather than replaying stale state.
  configureResources(game, runtime);
  game.game_init();
  checkExecutor(game);
  submitResources(game, runtime);
  assert.equal(runtime.runtime_resource_hash() >>> 0, trace[0][0]);
}

const server = serve(".", 0);
await once(server, "listening");
let browser;
try {
  browser = await chromium.launch({
    channel: process.env.PLAYER_BROWSER_CHANNEL || undefined,
  });
  const page = await browser.newPage();
  await page.goto(
    `http://127.0.0.1:${server.address().port}/${relative(process.cwd(), root).replaceAll("\\", "/")}/harness.html`,
  );
  for (const language of ["odin", "luau"]) {
    const base =
      "/" + relative(process.cwd(), resolve(projects[language], "build/web")).replaceAll("\\", "/");
    const trace = await page.evaluate(
      async ({ base, language }) => {
        const worker = new Worker(`${base}/worker.js`, { type: "module" });
        try {
          const request = (message, expected) =>
            new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error("Resource worker deadline")), 15000);
              worker.onerror = (event) => {
                clearTimeout(timer);
                reject(new Error(event.message));
              };
              worker.onmessage = ({ data }) => {
                if (data.type === "error") {
                  clearTimeout(timer);
                  reject(new Error(data.error));
                }
                if (data.type === expected) {
                  clearTimeout(timer);
                  resolve([data.resourceHash, data.resourceBytes]);
                }
              };
              worker.postMessage(message);
            });
          const load = {
            type: "load",
            resourceTrace: true,
            gameUrl: location.origin + base + (language === "luau" ? "/game.luau" : "/game.wasm"),
          };
          const trace = [await request(load, "ready")];
          for (let tick = 1; tick <= 120; tick++) {
            trace.push(
              await request(
                { type: "step", steps: 1, input: { buttons: 0, pointer: false, x: 0, y: 0 } },
                "frame",
              ),
            );
          }
          await request(load, "ready");
          try {
            await request(
              { type: "step", steps: 1, input: { buttons: 4, pointer: false, x: 0, y: 0 } },
              "frame",
            );
            throw new Error("Expected stale resource rejection");
          } catch (error) {
            if (!/stale (?:resource )?generation/i.test(error.message)) {
              throw error;
            }
          }
          return trace;
        } finally {
          worker.terminate();
        }
      },
      { base, language },
    );
    assert.deepEqual(trace, reference, `${language} actual browser Worker matches native trace`);
  }
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
await writeFile(
  resolve(root, "report.json"),
  JSON.stringify(
    {
      frames: reference.length,
      languages: Object.keys(projects),
      hosts: ["standalone-native", "browser-worker"],
      trace: reference,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Resource ownership passed: both SDKs, standalone native/browser, reload, skipped draws and atomic registry errors.",
);
