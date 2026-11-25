import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { decodeCartridge } from "../runtime/odin/web/cartridge.js";
import {
  checkExecutor,
  loadSource,
  rasterizeDrawing,
  submitDrawing,
} from "../runtime/odin/web/policy.js";
import { gameSource } from "./fixtures/luau-source.mjs";
import { packSource, sourceCode, sourcePng } from "./fixtures/luau-source-cartridge.mjs";
import { bundleLuau } from "./sdk/bundle.mjs";
import { nativePlayer } from "./toolchain.mjs";

const limit = 524288;
const oldLimit = 262144;
const repo = resolve(import.meta.dirname, "..");

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
