import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { decodeCartridge } from "../runtime/odin/web/cartridge.js";
import {
  checkExecutor,
  configureResources,
  inspectGuest,
  loadSource,
  rasterizeDrawing,
  readFrame,
  submitDrawing,
} from "../runtime/odin/web/policy.js";
import { gameSource } from "./fixtures/luau-source.mjs";
import { packSource, sourceCode, sourcePng } from "./fixtures/luau-source-cartridge.mjs";
import { sourceProof } from "./fixtures/luau-source-proof.mjs";
import { heapExecutor, heapGameSource } from "./fixtures/luau-heap-proof.mjs";
import { declaredMemoryMaximum, moduleWithMemory } from "./fixtures/wasm-memory.mjs";
import { bundleLuau } from "./sdk/bundle.mjs";
import { nativePlayer } from "./toolchain.mjs";

const limit = 524288;
const oldLimit = 262144;
const guestMemoryLimit = 33554432;
const luauHeapLimit = 8388608;
const wasmPageBytes = 65536;
const repo = resolve(import.meta.dirname, "..");
const contract = JSON.parse(await readFile(resolve(repo, "sdk/contract.json")));

test("contract allows 32 MiB of guest memory", () => {
  assert.equal(contract.limits.guestMemoryBytes, guestMemoryLimit);
});

test("contract allows an 8 MiB tracked Luau heap", () => {
  assert.equal(contract.limits.luauHeapBytes, luauHeapLimit);
});

function memoryDeclarations(value, path = "", field = "guestMemoryBytes") {
  return Object.entries(value).flatMap(([key, child]) => {
    const name = path ? `${path}.${key}` : key;
    if (key === field) {
      return [[name, child]];
    }
    return child && typeof child === "object" ? memoryDeclarations(child, name, field) : [];
  });
}

let profilesWithGuestMemory = 0;
let profilesWithLuauHeap = 0;
for (const name of (await readdir(resolve(repo, "sdk/profiles")))
  .filter((name) => name.endsWith(".json"))
  .sort()) {
  const profile = JSON.parse(await readFile(resolve(repo, "sdk/profiles", name)));
  const declarations = memoryDeclarations(profile);
  if (declarations.length) {
    profilesWithGuestMemory++;
  }
  for (const [path, value] of declarations) {
    test(`${name} ${path} allows 32 MiB of guest memory`, () => {
      assert.equal(value, guestMemoryLimit, `${name}: ${path}`);
    });
  }
  const heapDeclarations = memoryDeclarations(profile, "", "luauHeapBytes");
  if (heapDeclarations.length) {
    profilesWithLuauHeap++;
  }
  for (const [path, value] of heapDeclarations) {
    test(`${name} ${path} allows an 8 MiB tracked Luau heap`, () => {
      assert.equal(value, luauHeapLimit, `${name}: ${path}`);
    });
  }
}

test("at least one profile declares luauHeapBytes", () => {
  assert.ok(profilesWithLuauHeap > 0, "no profiles declare luauHeapBytes");
});

for (const [path, declaration] of [
  ["runtime/odin/web/constants.js", /export const MAX_LUAU_HEAP_BYTES = (\d+);/],
  ["runtime/odin/abi/constants.odin", /MAX_LUAU_HEAP_BYTES :: (\d+)/],
  ["sdk/luau/constants.luau", /MAX_LUAU_HEAP_BYTES = (\d+),/],
  ["experiments/luau-executor/console_constants.h", /constexpr auto MAX_LUAU_HEAP_BYTES = (\d+)u;/],
]) {
  test(`${path} generates an 8 MiB tracked Luau heap limit`, async () => {
    const match = declaration.exec(await readFile(resolve(repo, path), "utf8"));
    assert.ok(match, `missing MAX_LUAU_HEAP_BYTES declaration in ${path}`);
    assert.equal(Number(match[1]), luauHeapLimit, path);
  });
}

for (const [setting, argument] of [
  ["LUA_GCSETGOAL", "125"],
  ["LUA_GCSETSTEPMUL", "(\\d+)"],
]) {
  test(`executor sets ${setting} after lua_newstate`, async () => {
    const source = await readFile(resolve(repo, "experiments/luau-executor/executor.cpp"), "utf8");
    const init = source.slice(
      source.indexOf("void game_init()"),
      source.indexOf("void game_update("),
    );
    const allocation = init.indexOf("lua_newstate(");
    const call = new RegExp(
      `lua_gc\\(\\s*state\\s*,\\s*${setting}\\s*,\\s*${argument}\\s*\\)`,
    ).exec(init);
    assert.ok(allocation >= 0, "missing lua_newstate in game_init");
    assert.ok(call, `missing lua_gc(state, ${setting}, ${argument}) after lua_newstate`);
    assert.ok(call.index > allocation, `${setting} must follow lua_newstate`);
    if (setting === "LUA_GCSETSTEPMUL") {
      assert.ok(
        Number(call[1]) > 200,
        "GC step work must exceed Luau's default 200 to keep up with allocation at a 125% goal",
      );
    }
  });
}

for (const path of ["docs/cartridge-spec.md", "sdk/resources.md", "sdk/graphics.md"]) {
  test(`${path} documents 32 MiB guest memory and an 8 MiB tracked Luau heap`, async () => {
    const text = (await readFile(resolve(repo, path), "utf8")).replace(/\s+/g, " ");
    assert.ok(
      /(?:explicit maximum at or below 32 MiB|guest memory(?: remains capped at)? 32 MiB)/i.test(
        text,
      ),
      `${path}: missing 32 MiB guest memory statement`,
    );
    assert.ok(
      /(?:8 MiB tracked Luau heap|tracked Luau heap(?: at)? 8 MiB)/.test(text),
      `${path}: missing 8 MiB tracked Luau heap statement`,
    );
    assert.ok(
      !/guest memory(?: remains capped at)? 8 MiB/i.test(text),
      `${path}: stale 8 MiB guest limit`,
    );
    assert.ok(
      !/(?:4 MiB tracked Luau heap|tracked allocator limit is 4 MiB|tracked Luau heap(?: at)? 4 MiB)/.test(
        text,
      ),
      `${path}: stale 4 MiB tracked Luau heap`,
    );
  });
}

test(
  "real executor retains about 2.5 MB and survives 400 allocation-churn ticks",
  { timeout: 10000 },
  async () => {
    const game = await heapExecutor(heapGameSource());
    assert.doesNotThrow(() => game.game_init(), "heap workload init must not trap");
    checkExecutor(game);
    const liveBytes = game.game_heap_bytes();
    assert.ok(liveBytes >= 2300000 && liveBytes <= 2800000, `${liveBytes} initial live heap bytes`);
    console.log(`Luau heap workload: ${liveBytes} initial tracked live heap bytes`);
    // 400 ticks allocate 204800 temporary rows while every initial row stays reachable.
    for (let tick = 1; tick <= 400; tick++) {
      assert.doesNotThrow(
        () => game.game_update(0, 0, 0, 0),
        `heap churn tick ${tick} must not trap`,
      );
      const peak = game.game_heap_peak();
      assert.ok(
        peak <= contract.limits.luauHeapBytes,
        `${peak} peak bytes exceed the tracked heap cap`,
      );
      assert.ok(game.memory.buffer.byteLength <= contract.limits.guestMemoryBytes);
      assert.doesNotThrow(
        () => checkExecutor(game),
        `heap churn tick ${tick}: ${peak}/${contract.limits.luauHeapBytes} peak heap bytes`,
      );
    }
    const frame = readFrame(game);
    assert.equal(frame.x, 3200, "all initial live rows remain reachable");
    assert.equal(frame.y, 400, "all churn ticks completed");
    assert.ok(game.game_heap_peak() <= contract.limits.luauHeapBytes);
    const peak = game.game_heap_peak();
    const gcBound = liveBytes * 1.6 + 256 * 1024;
    console.log(
      `Luau churn proof: ${liveBytes} live bytes, ${peak} peak bytes, ${(peak / liveBytes).toFixed(3)} peak/live`,
    );
    assert.ok(
      peak <= gcBound,
      `${peak} peak bytes exceed the tighter GC bound ${gcBound} for ${liveBytes} live bytes`,
    );
  },
);

test(
  "real executor reports growing live data OOM through checkExecutor without exceeding its cap",
  { timeout: 10000 },
  async () => {
    const game = await heapExecutor(heapGameSource({ growing: true }));
    assert.doesNotThrow(() => game.game_init(), "growing workload init must not trap");
    checkExecutor(game);
    let failure;
    let ticks = 0;
    for (; ticks < 256; ticks++) {
      assert.doesNotThrow(() => game.game_update(0, 0, 0, 0), "OOM must not escape as a Wasm trap");
      assert.ok(game.game_heap_peak() <= contract.limits.luauHeapBytes);
      assert.ok(game.memory.buffer.byteLength <= contract.limits.guestMemoryBytes);
      try {
        checkExecutor(game);
      } catch (error) {
        failure = error;
        break;
      }
    }
    assert.ok(failure, "growing reachable data must exhaust the tracked heap within 256 ticks");
    assert.match(failure.message, /not enough memory|out of memory/i);
    console.log(
      `Luau growing heap: ${failure.message}, tick ${ticks + 1}, peak ${game.game_heap_peak()}/${contract.limits.luauHeapBytes} bytes`,
    );
  },
);

test(
  "exactly 524288 source bytes can grow to heap OOM within the guest memory budget",
  { timeout: 10000 },
  async () => {
    const code = Buffer.from(
      gameSource(limit - 8192, heapGameSource({ growing: true, retainRooms: true })),
    );
    assert.ok(code.length <= limit, `${code.length} generated source bytes before padding`);
    const source = Buffer.alloc(limit, 0x20);
    code.copy(source);
    assert.equal(source.length, 524288);
    const game = await heapExecutor(source);
    assert.doesNotThrow(() => game.game_init(), "maximum-source init must not trap");
    checkExecutor(game);
    let failure;
    let memoryPeak = game.memory.buffer.byteLength;
    for (let tick = 1; tick <= 256; tick++) {
      assert.doesNotThrow(
        () => game.game_update(0, 0, 0, 0),
        `maximum-source growth tick ${tick} must not trap`,
      );
      memoryPeak = Math.max(memoryPeak, game.memory.buffer.byteLength);
      assert.ok(memoryPeak <= contract.limits.guestMemoryBytes, `${memoryPeak} guest memory bytes`);
      assert.ok(game.game_heap_peak() <= contract.limits.luauHeapBytes);
      try {
        checkExecutor(game);
      } catch (error) {
        failure = error;
        break;
      }
    }
    assert.ok(failure, "maximum-source game must exhaust the tracked heap within 256 ticks");
    assert.match(failure.message, /not enough memory/i);
    console.log(
      `Luau maximum-source OOM: ${source.length} source bytes, ${game.game_heap_peak()} heap peak bytes, ${memoryPeak} guest memory bytes; ${failure.message}`,
    );
  },
);

test("at least one profile declares guestMemoryBytes", () => {
  assert.ok(profilesWithGuestMemory > 0, "no profiles declare guestMemoryBytes");
});

for (const [path, declaration] of [
  ["runtime/odin/web/constants.js", /export const MAX_MEMORY_BYTES = (\d+);/],
  ["runtime/odin/abi/constants.odin", /MAX_MEMORY_BYTES :: (\d+)/],
  ["sdk/luau/constants.luau", /MAX_MEMORY_BYTES = (\d+),/],
  ["experiments/luau-executor/console_constants.h", /constexpr auto MAX_MEMORY_BYTES = (\d+)u;/],
]) {
  test(`${path} generates a 32 MiB guest memory limit`, async () => {
    const match = declaration.exec(await readFile(resolve(repo, path), "utf8"));
    assert.ok(match, `missing MAX_MEMORY_BYTES declaration in ${path}`);
    assert.equal(Number(match[1]), guestMemoryLimit, path);
  });
}

test("executor CMake maximum memory is 32 MiB", async () => {
  const source = await readFile(resolve(repo, "experiments/luau-executor/CMakeLists.txt"), "utf8");
  const match = /-sMAXIMUM_MEMORY=(\d+)\b/.exec(source);
  assert.ok(match, "missing executor maximum memory setting");
  assert.equal(Number(match[1]), guestMemoryLimit);
});

test("built executor declares an exported memory maximum of 32 MiB", async () => {
  const bytes = await readFile(resolve(repo, "build/luau-executor/luau-executor.wasm"));
  assert.equal(declaredMemoryMaximum(bytes), guestMemoryLimit);
});

test("inspectGuest accepts the existing 8 MiB memory declaration", () => {
  assert.ok(inspectGuest(moduleWithMemory(128)) instanceof WebAssembly.Module);
});

test("inspectGuest accepts a 32 MiB memory maximum", () => {
  assert.ok(
    inspectGuest(moduleWithMemory(guestMemoryLimit / wasmPageBytes)) instanceof WebAssembly.Module,
  );
});

test("inspectGuest rejects a memory maximum one page over 32 MiB", () => {
  assert.throws(
    () => inspectGuest(moduleWithMemory(guestMemoryLimit / wasmPageBytes + 1)),
    /memory.*maximum/i,
  );
});

function completionMailbox(capacity) {
  const sessions = [];
  const game = {
    game_abi: () => 1,
    game_frame_size: () => 40,
    game_resource_protocol: () => 2,
    game_resource_configure: (session) => {
      assert.equal(session, 1);
      return 1;
    },
    game_commit: () => 0,
    game_commit_size: () => 0,
    game_commit_ack: () => 1,
    game_resource_mailbox: () => 0,
    game_resource_mailbox_capacity: () => capacity,
    game_resource_mailbox_size: () => 1,
  };
  const runtime = {
    runtime_resource_reset: (protocol) => {
      sessions.push(protocol);
      return 1;
    },
  };
  return { game, runtime, sessions };
}

for (const capacity of [8388608, guestMemoryLimit]) {
  test(`configureResources accepts a ${capacity}-byte completion mailbox capacity`, () => {
    const { game, runtime, sessions } = completionMailbox(capacity);
    assert.doesNotThrow(() => configureResources(game, runtime));
    assert.deepEqual(sessions, [2]);
  });
}

test("configureResources rejects a completion mailbox capacity one byte over 32 MiB", () => {
  const { game, runtime, sessions } = completionMailbox(guestMemoryLimit + 1);
  assert.throws(() => configureResources(game, runtime), /Invalid completion mailbox capacity/);
  assert.deepEqual(sessions, []);
});

test("cartridge specification documents a 32 MiB guest memory maximum", async () => {
  const text = (await readFile(resolve(repo, "docs/cartridge-spec.md"), "utf8")).replace(
    /\s+/g,
    " ",
  );
  const maximum = /explicit maximum at or below (\d+) MiB/.exec(text);
  assert.ok(maximum, "missing guest memory maximum statement");
  assert.equal(Number(maximum[1]), 32, maximum[0]);
  assert.doesNotMatch(text, /(?:maximum at or below|inside the) 8 MiB/);
});

test("exact-limit source fixture contains exactly 524288 bytes", () => {
  assert.equal(sourceCode(limit).length, limit);
});

for (const minimumBytes of [500000, 520000, 524288]) {
  const size = minimumBytes === limit ? `exactly ${limit}` : `at least ${minimumBytes}`;
  test(`executor initializes ${size} source bytes within the memory and heap budgets`, async () => {
    const bytes = await readFile(resolve(repo, "build/luau-executor/luau-executor.wasm"));
    const names = [
      "content_size",
      "content_read",
      "save_size",
      "save_status",
      "save_read",
      "save_write",
      "text_configure",
      "text_read",
    ];
    const imports = { env: Object.fromEntries(names.map((name) => [name, () => 0])) };
    console.log(await sourceProof(bytes, imports, contract, minimumBytes));
  });
}

for (const [name, value] of [
  [
    "contract",
    JSON.parse(await readFile(resolve(repo, "sdk/contract.json"))).limits.luauSourceBytes,
  ],
  [
    "profile",
    JSON.parse(await readFile(resolve(repo, "sdk/profiles/2d-preview-1.json"))).limits
      .luauSourceBytes,
  ],
]) {
  test(`${name} allows 512 KiB of Luau source`, () => assert.equal(value, limit));
}

for (const [path, declaration] of [
  ["runtime/odin/web/constants.js", /export const MAX_LUAU_SOURCE_BYTES = (\d+);/],
  ["runtime/odin/abi/constants.odin", /MAX_LUAU_SOURCE_BYTES :: (\d+)/],
  ["sdk/luau/constants.luau", /MAX_LUAU_SOURCE_BYTES = (\d+),/],
  [
    "experiments/luau-executor/console_constants.h",
    /constexpr auto MAX_LUAU_SOURCE_BYTES = (\d+)u;/,
  ],
]) {
  test(`${path} generates a 512 KiB Luau source limit`, async () => {
    const match = declaration.exec(await readFile(resolve(repo, path), "utf8"));
    assert.ok(match, `missing MAX_LUAU_SOURCE_BYTES declaration in ${path}`);
    assert.equal(Number(match[1]), limit, path);
  });
}

for (const path of ["docs/cartridge-spec.md", "docs/png-cartridges.md"]) {
  test(`${path} documents 512 KiB for Luau source`, async () => {
    const text = (await readFile(resolve(repo, path), "utf8")).replace(/\s+/g, " ");
    const sourceLimit = /Luau(?: bundled)? (?:source|code)[^.;]*?at most (\d+) KiB/g;
    const statements = [...text.matchAll(sourceLimit)].map((match) => match[0]);
    assert.ok(statements.length > 0, "missing Luau source size statement");
    assert.ok(
      statements.some((statement) => statement.includes("512 KiB")),
      statements.join("\n"),
    );
    assert.doesNotMatch(text, /Luau[^.;]*\b256 KiB|source comments[^.;]*\b256 KiB/);
  });
}

async function project(t, sizes) {
  const directory = await mkdtemp(join(repo, "build/luau-source-limit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requires = [];
  for (const [index, size] of sizes.entries()) {
    await writeFile(join(directory, `rooms${index}.luau`), gameSource(size, "return rooms\n"));
    requires.push(`local rooms${index} = require("./rooms${index}")`);
  }
  const entry = join(directory, "main.luau");
  await writeFile(
    entry,
    requires.join("\n") +
      "\nreturn { init = function() end, update = function() end, draw = function() end }\n",
  );
  return { entry, project: directory, sdkRoot: resolve(repo, "sdk/luau"), assets: Buffer.alloc(0) };
}

test("bundles game modules above 256 KiB and within 512 KiB", async (t) => {
  const output = await bundleLuau(await project(t, [80000, 80000, 80000, 80000]));
  assert.ok(output.length > oldLimit && output.length <= limit, `${output.length} bundled bytes`);
});

test("rejects bundled output above 512 KiB with its byte count", async (t) => {
  const options = await project(t, [180000, 180000, 180000, 180000]);
  await assert.rejects(bundleLuau(options), (error) => {
    assert.match(error.message, /Bundled Luau source exceeds 512 KiB \((\d+) bytes\)/);
    const bytes = Number(/\((\d+) bytes\)/.exec(error.message)[1]);
    assert.ok(bytes > limit, `${bytes} bundled bytes`);
    return true;
  });
});

test("accepts a single module above 256 KiB and within 512 KiB", async (t) => {
  const options = await project(t, [300000]);
  const source = await readFile(join(options.project, "rooms0.luau"));
  assert.ok(source.length > oldLimit && source.length <= limit);
  const output = await bundleLuau(options);
  assert.ok(output.length > oldLimit && output.length <= limit, `${output.length} bundled bytes`);
});

test("rejects a single module above 512 KiB with the module-graph error", async (t) => {
  const options = await project(t, [limit + 1]);
  assert.ok((await readFile(join(options.project, "rooms0.luau"))).length > limit);
  await assert.rejects(bundleLuau(options), /Luau module graph exceeds preview limits/);
});

function executor() {
  let loaded = 0;
  return {
    memory: new WebAssembly.Memory({ initial: 9 }),
    game_source_buffer: () => 16,
    game_source_capacity: () => limit + 1,
    game_source_size: (size) => {
      loaded = size;
    },
    loaded: () => loaded,
  };
}

test("loadSource copies 300,000 bytes into an executor with sufficient capacity", () => {
  const game = executor();
  const source = Buffer.alloc(300000, 97);
  loadSource(game, source);
  assert.equal(game.loaded(), source.length);
  assert.deepEqual(new Uint8Array(game.memory.buffer, 16, source.length), new Uint8Array(source));
});

test("loadSource rejects 524,289 bytes even when executor capacity permits it", () => {
  const game = executor();
  assert.throws(() => loadSource(game, Buffer.alloc(limit + 1)), /Invalid source or executor/);
  assert.equal(game.loaded(), 0);
});

test("source loaders use the generated limit instead of 256 KiB literals", async () => {
  const violations = [];
  async function scan(directory) {
    for (const entry of await readdir(resolve(repo, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        await scan(path);
      } else if (
        /\.(?:mjs|js|odin|cpp|cc|c|h|hpp)$/.test(entry.name) ||
        entry.name === "CMakeLists.txt"
      ) {
        if (path === "experiments/luau-executor/console_constants.h") {
          continue;
        }
        const lines = (await readFile(resolve(repo, path), "utf8")).split("\n");
        lines.forEach((line, index) => {
          if (
            path === "runtime/odin/guest/guest.odin" &&
            /wasmtime_config_max_wasm_stack_set/.test(line)
          ) {
            return;
          }
          if (
            /\bBUTTON_POINTER_HOVER\b|\bpointer_hover\b|\bBUTTON_WHEEL_UP\b|\bwheel_up\b/.test(line)
          ) {
            return;
          }
          const sourceLine = line.replace(/-sSTACK_SIZE=262144\b/g, "");
          if (/\b256\s*\*\s*1024\b|\b262144(?:[uUlL]*)\b/.test(sourceLine)) {
            violations.push(`${path}:${index + 1}: ${line.trim()}`);
          }
        });
      }
    }
  }
  await scan("tools/sdk");
  await scan("runtime/odin");
  await scan("experiments/luau-executor");
  assert.deepEqual(violations, [], violations.join("\n"));
});

async function runtime() {
  return (
    await WebAssembly.instantiate(
      await readFile(resolve(repo, "build/odin-player/web/runtime.wasm")),
      { env: { sin: Math.sin } },
    )
  ).instance.exports;
}

async function nativeSource(t, code, cartridge) {
  const directory = await mkdtemp(join(repo, "build/luau-source-native-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, cartridge ? "game.png" : "game.luau");
  await writeFile(path, code);
  const args = cartridge
    ? [
        "--game",
        path,
        "--executor",
        resolve(repo, "build/luau-executor/luau-executor.wasm"),
        "--smoke",
      ]
    : [
        "--game",
        resolve(repo, "build/luau-executor/luau-executor.wasm"),
        "--source",
        path,
        "--smoke",
      ];
  const result = spawnSync(resolve(repo, "build/odin-player/native", nativePlayer), args, {
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      SDL_VIDEODRIVER: "dummy",
      SDL_AUDIODRIVER: "dummy",
      SDL_RENDER_DRIVER: "software",
    },
  });
  assert.ifError(result.error);
  return result;
}

test("native --source rejects exactly 524289 bytes at the file size limit", async (t) => {
  const code = sourceCode(limit + 1);
  assert.equal(code.length, limit + 1);
  const result = await nativeSource(t, code, false);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /cartridge or source file exceeds size limit or is empty/);
});

test("native guest initializes and runs 520000 source bytes within the memory limit", async (t) => {
  const source = sourceCode(520000);
  assert.ok(source.length >= 520000 && source.length <= limit);
  const result = await nativeSource(t, source, false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ticks, 120);
});

test("native guest rejects a memory maximum one page over 32 MiB", async (t) => {
  const module = moduleWithMemory(guestMemoryLimit / wasmPageBytes + 1);
  assert.ok(WebAssembly.validate(module), "memory fixture must be valid Wasm");
  const directory = await mkdtemp(join(repo, "build/luau-memory-native-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "over-limit.wasm");
  await writeFile(path, module);
  const result = spawnSync(
    resolve(repo, "build/odin-player/native", nativePlayer),
    ["--game", path, "--check"],
    {
      encoding: "utf8",
      timeout: 30000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /game memory must declare .* maximum or less/i);
});

for (const bytes of [10000, 300000]) {
  test(`packer round trips ${bytes} bytes through the web cartridge decoder`, async () => {
    const code = sourceCode(bytes);
    assert.equal(code.length, bytes);
    const packed = packSource(code);
    assert.deepEqual(
      packed,
      sourcePng(code),
      "parser fixtures match the real packer byte for byte",
    );
    const cart = decodeCartridge(await runtime(), packed);
    assert.equal(cart.language, "luau");
    assert.deepEqual(cart.code, new Uint8Array(code));
  });

  test(`web parser accepts and executes a ${bytes}-byte Luau cartridge`, async () => {
    const code = sourceCode(bytes);
    const host = await runtime();
    const cart = decodeCartridge(host, sourcePng(code));
    assert.deepEqual(cart.code, new Uint8Array(code));
    const imports = Object.fromEntries(
      [
        "content_size",
        "content_read",
        "save_size",
        "save_status",
        "save_read",
        "save_write",
        "text_configure",
        "text_read",
      ].map((name) => [name, () => 0]),
    );
    const game = (
      await WebAssembly.instantiate(
        await readFile(resolve(repo, "build/luau-executor/luau-executor.wasm")),
        { env: imports },
      )
    ).instance.exports;
    game._initialize?.();
    loadSource(game, cart.code);
    game.game_init();
    checkExecutor(game);
    host.runtime_init();
    rasterizeDrawing(host, submitDrawing(game, host));
    checkExecutor(game);
    assert.equal(new Uint32Array(host.memory.buffer, host.runtime_pixels(), 1)[0], 0xff102030);
  });

  test(`native parser accepts and runs a ${bytes}-byte Luau cartridge`, async (t) => {
    const result = await nativeSource(t, sourcePng(sourceCode(bytes)), true);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ticks, 120);
  });
}

test("packer rejects exactly 524289 bytes of Luau code", () => {
  assert.throws(() => packSource(sourceCode(limit + 1)), /Invalid cartridge language or code size/);
});

test("web parser rejects exactly 524289 bytes of Luau code", async () => {
  const host = await runtime();
  assert.throws(
    () => decodeCartridge(host, sourcePng(sourceCode(limit + 1))),
    /invalid cartridge title or code length/,
  );
});

test("native parser rejects exactly 524289 bytes of Luau code", async (t) => {
  const result = await nativeSource(t, sourcePng(sourceCode(limit + 1)), true);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /invalid cartridge title or code length/);
});
