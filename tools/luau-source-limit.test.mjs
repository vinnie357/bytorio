import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { MAX_LUAU_SOURCE_BYTES } from "../runtime/odin/web/constants.js";
import { loadSource } from "../runtime/odin/web/policy.js";
import { gameSource } from "./fixtures/luau-source.mjs";
import { bundleLuau } from "./sdk/bundle.mjs";

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
  ["generated browser constant", MAX_LUAU_SOURCE_BYTES],
]) {
  test(`${name} allows 512 KiB of Luau source`, () => assert.equal(value, limit));
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
      } else if (/\.(?:mjs|js|odin)$/.test(entry.name)) {
        const lines = (await readFile(resolve(repo, path), "utf8")).split("\n");
        lines.forEach((line, index) => {
          if (
            path === "runtime/odin/guest/guest.odin" &&
            /wasmtime_config_max_wasm_stack_set/.test(line)
          ) {
            return;
          }
          if (/\b256\s*\*\s*1024\b/.test(line)) {
            violations.push(`${path}:${index + 1}: ${line.trim()}`);
          }
        });
      }
    }
  }
  await scan("tools/sdk");
  await scan("runtime/odin");
  assert.deepEqual(violations, [], violations.join("\n"));
});
