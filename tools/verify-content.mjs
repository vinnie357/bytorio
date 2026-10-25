import { nativePlayer } from "./toolchain.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { timedSpawnSync as spawnSync } from "./command-timing.mjs";
import { createProject, buildProject } from "./sdk/project.mjs";
import {
  chunks,
  chunk,
  signature,
  encodeContent,
  crc32,
  CONTENT_LIMIT,
  PNG_LIMIT,
} from "./sdk/cartridge.mjs";
import { MAX_GAME_BYTES, MAX_CONTENT_READ_BYTES } from "../runtime/odin/web/constants.js";
import { decodeCartridge, contentImports } from "../runtime/odin/web/cartridge.js";
import { chromium } from "./browser-timing.mjs";
import { serve } from "./serve.mjs";

const root = resolve("build/content-verification", randomUUID());
await mkdir(root, { recursive: true });
const asset = Buffer.alloc(3 * 1024 * 1024);
for (let i = 0; i < asset.length; i++) {
  asset[i] = i & 255;
}
const projects = {};
const images = {};
const reports = {};
assert.equal(CONTENT_LIMIT, 512 * 1024 * 1024);
assert.equal(PNG_LIMIT, 2 * 1024 * 1024);
assert.equal(MAX_GAME_BYTES, 1024 * 1024);
assert.equal(MAX_CONTENT_READ_BYTES, 1024 * 1024);
function native(project, path, expected = 0) {
  const result = spawnSync(resolve(project, "build/native", nativePlayer), [path, "--smoke"], {
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
  assert.equal(result.status, expected, result.stderr + result.stdout);
  return result;
}
for (const language of ["odin", "luau"]) {
  const project = resolve(root, language);
  projects[language] = project;
  await createProject(project, language);
  await copyFile(`tests/content/game.${language}`, resolve(project, `src/main.${language}`));
  await writeFile(resolve(project, "large.bin"), asset);
  await writeFile(resolve(project, "small.bin"), Buffer.from([17, 23, 41, 89]));
  const manifest = JSON.parse(await readFile(resolve(project, "console.json"), "utf8"));
  manifest.content = [
    { id: 0xffffffff, path: "small.bin" },
    { id: 7, path: "large.bin" },
  ];
  await writeFile(resolve(project, "console.json"), JSON.stringify(manifest));
  await buildProject(project);
  const path = resolve(project, "build/game.png");
  images[language] = await readFile(path);
  reports[language] = JSON.parse(native(project, path).stdout);
}
// Retain the original small cartridges and add a second fixture above the old
// 64 MiB bound. Both guests independently check bytes at a high source offset.
const highAsset = Buffer.alloc(65 * 1024 * 1024);
for (let i = 0; i < highAsset.length; i++) {
  highAsset[i] = i & 255;
}
for (const language of ["odin", "luau"]) {
  const parts = chunks(images[language]);
  const content = encodeContent([
    { id: 7, bytes: asset },
    { id: 8, bytes: highAsset },
    { id: 0xffffffff, bytes: Buffer.from([17, 23, 41, 89]) },
  ]);
  const image = Buffer.concat([
    signature,
    ...parts.map((part) => chunk(part.type, part.type === "coNt" ? content : part.data)),
  ]);
  const path = resolve(projects[language], "build/web/large.png");
  await writeFile(path, image);
  assert.deepEqual(JSON.parse(native(projects[language], path).stdout), reports[language]);
}
const runtime = (
  await WebAssembly.instantiate(await readFile(resolve(projects.odin, "build/web/runtime.wasm")), {
    env: { sin: Math.sin },
  })
).instance.exports;
decodeCartridge(runtime, images.odin);
const memory = new WebAssembly.Memory({ initial: 17, maximum: 128 });
const access = contentImports(runtime, () => ({ memory }));
const destination = new Uint8Array(memory.buffer, 128, 4);
destination.fill(91);
assert.equal(access.content_size(7), asset.length);
assert.equal(access.content_read(7, 1023, 128, 4), 1);
assert.deepEqual([...destination], [255, 0, 1, 2]);
for (const args of [
  [7, asset.length - 3, 128, 4],
  [7, 0xffffffff, 128, 4],
  [7, 0, 0xffffffff, 4],
  [7, 0, 0, 1048577],
  [9, 0, 128, 4],
]) {
  assert.equal(access.content_read(...args), 0);
  assert.deepEqual([...destination], [255, 0, 1, 2]);
}
assert.equal(access.content_read(7, asset.length, 128, 0), 1);
assert.equal(access.content_size(9), 0);
for (const input of [new Uint8Array(0), new Uint8Array(runtime.runtime_cartridge_capacity() + 1)]) {
  decodeCartridge(runtime, images.odin);
  assert.throws(() => decodeCartridge(runtime, input), /size/);
  assert.equal(access.content_size(7), 0, "invalid outer size clears previous content");
  assert.equal(access.content_read(7, 0, 128, 4), 0);
  assert.deepEqual([...destination], [255, 0, 1, 2]);
}
const parts = chunks(images.odin);
const content = parts.find(({ type }) => type === "coNt").data;
function malformedContent(edit) {
  const bytes = Buffer.from(content);
  edit(bytes);
  return Buffer.concat([
    signature,
    ...parts.map((part) => chunk(part.type, part.type === "coNt" ? bytes : part.data)),
  ]);
}
const malformed = [
  ["version", (b) => b.writeUInt32LE(2, 4)],
  ["empty-index", (b) => b.writeUInt32LE(0, 8)],
  ["index-overflow", (b) => b.writeUInt32LE(0xffffffff, 8)],
  ["zero-id", (b) => b.writeUInt32LE(0, 12)],
  ["duplicate-id", (b) => b.writeUInt32LE(7, 24)],
  ["overlap", (b) => b.writeUInt32LE(0, 28)],
  ["gap", (b) => b.writeUInt32LE(1, 16)],
  ["overflow", (b) => b.writeUInt32LE(0xffffffff, 20)],
  ["empty-entry", (b) => b.writeUInt32LE(0, 20)],
  ["trailing-data", (b) => b.writeUInt32LE(3, 32)],
];
for (const [name, edit] of malformed) {
  const png = malformedContent(edit);
  assert.throws(() => decodeCartridge(runtime, png), /content/);
  assert.equal(runtime.runtime_content_size(7), 0, "failed parse cannot publish previous content");
  const path = resolve(root, `${name}.png`);
  await writeFile(path, png);
  assert.match(native(projects.odin, path, 1).stderr, /content/);
}
for (const entries of [
  [{ id: 0, bytes: asset }],
  [{ id: 1, bytes: Buffer.alloc(0) }],
  [
    { id: 7, bytes: asset },
    { id: 7, bytes: asset },
  ],
]) {
  assert.throws(() => encodeContent(entries));
}
const stripped = Buffer.concat([
  signature,
  ...parts.filter((part) => part.type !== "coNt").map((part) => chunk(part.type, part.data)),
]);
decodeCartridge(runtime, images.odin);
decodeCartridge(runtime, stripped);
assert.equal(
  runtime.runtime_content_size(7),
  0,
  "reloading a content-free cartridge clears the index",
);

const server = serve(root, 0);
await once(server, "listening");
const browser = await chromium.launch({
  channel: process.env.PLAYER_BROWSER_CHANNEL || "chrome",
  headless: true,
});
try {
  const page = await browser.newPage();
  for (const language of ["odin", "luau"]) {
    for (const file of ["game.png", "large.png"]) {
      await page.goto(
        `http://127.0.0.1:${server.address().port}/${language}/build/web/player.html?game=./${file}&smoke`,
      );
      await page.waitForFunction(() => playerStatus.ready || playerStatus.error);
      assert.equal(await page.evaluate(() => playerStatus.error), "");
      await page.locator("#start").click();
      await page.waitForFunction(() => playerStatus.ticks >= 120 || playerStatus.error);
      assert.equal(await page.evaluate(() => playerStatus.error), "");
      assert.equal(await page.evaluate(() => playerStatus.hash), reports[language].hash);
      if (file === "large.png") {
        await page
          .locator('input[type="file"]')
          .setInputFiles(resolve(projects[language], "build/web/large.png"));
        await page.waitForFunction(() => playerStatus.ready || playerStatus.error);
        assert.equal(await page.evaluate(() => playerStatus.error), "");
        assert.equal(await page.evaluate(() => playerStatus.hash), reports[language].hash);
      }
    }
  }
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}

// Exercise the exact 512 MiB parser bound without allocating a second complete
// JS cartridge. The index and blobs must borrow the reserved runtime buffer.
const base = stripped.subarray(0, -12),
  ending = stripped.subarray(-12);
const maximumFile = base.length + CONTENT_LIMIT + 13 + ending.length;
const pointer = runtime.runtime_cartridge_reserve(maximumFile);
assert.ok(pointer);
const bytes = new Uint8Array(runtime.memory.buffer, pointer, maximumFile);
bytes.set(base);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const at = base.length,
  payload = at + 8;
bytes.set(Buffer.from("coNt"), at + 4);
view.setUint32(payload, 0x544e5443, true);
view.setUint32(payload + 4, 1, true);
view.setUint32(payload + 8, 1, true);
view.setUint32(payload + 12, 11, true);
view.setUint32(payload + 16, 0, true);
for (const length of [CONTENT_LIMIT + 1, CONTENT_LIMIT]) {
  view.setUint32(at, length);
  view.setUint32(payload + 20, length - 24, true);
  bytes[payload + 24] = 37;
  bytes[payload + length - 1] = 91;
  view.setUint32(payload + length, crc32(bytes.subarray(at + 4, payload + length)));
  bytes.set(ending, payload + length + 4);
  const result = runtime.runtime_cartridge_parse(base.length + length + 12 + ending.length);
  assert.equal(result, length === CONTENT_LIMIT ? 2 : 0);
}
assert.equal(runtime.runtime_content_size(11), CONTENT_LIMIT - 24);
assert.equal(runtime.runtime_content_pointer(11), pointer + payload + 24);
assert.equal(access.content_read(11, 0, 128, 1), 1);
assert.equal(destination[0], 37);
assert.equal(access.content_read(11, CONTENT_LIMIT - 25, 128, 1), 1);
assert.equal(destination[0], 91);
await writeFile(
  resolve(root, "report.json"),
  JSON.stringify(
    {
      status: "passed",
      contentLimit: CONTENT_LIMIT,
      moduleLimit: MAX_GAME_BYTES,
      previewLimit: PNG_LIMIT,
      readLimit: MAX_CONTENT_READ_BYTES,
      legacyPayloadBytes: asset.length,
      largePayloadBytes: asset.length + highAsset.length,
      maximumIndexedBytes: CONTENT_LIMIT,
      maximumRejectedIndexedBytes: CONTENT_LIMIT + 1,
      runtimeMemoryBytesAtMaximum: runtime.memory.buffer.byteLength,
      parsedContentBorrowsBacking: true,
      nativeLanguages: ["odin", "luau"],
      browserLanguages: ["odin", "luau"],
      browserLoadPaths: ["http", "file"],
    },
    null,
    2,
  ) + "\n",
);
runtime.runtime_cartridge_reserve(0);
console.log(
  `Indexed content passed: legacy and >64 MiB files through both SDKs/native/browser, exact 512 MiB boundary, oversized rejection, borrowed backing storage, ${malformed.length} malformed indexes, bounded reads, failed-parse rollback and reload clearing.`,
);
