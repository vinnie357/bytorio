import { nativePlayer } from "./toolchain.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, copyFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { chromium } from "./browser-timing.mjs";
import { createProject, packProject } from "./sdk/project.mjs";
import {
  chunks,
  chunk,
  signature,
  PNG_LIMIT,
  defaultCover,
  encodeCartridge,
} from "./sdk/cartridge.mjs";
import { decodeCartridge } from "../runtime/odin/web/cartridge.js";
import { MAX_GAME_BYTES, MAX_LUAU_SOURCE_BYTES } from "../runtime/odin/web/constants.js";
import { inspectGuest, loadSource, checkExecutor } from "../runtime/odin/web/policy.js";
import { bundleLuau } from "./sdk/bundle.mjs";
import { formatSource } from "./code-tools.mjs";
import { serve } from "./serve.mjs";

const root = resolve("build/cartridge-verification", randomUUID());
await mkdir(root, { recursive: true });
const projects = {},
  images = {},
  reports = {};
const env = {
  ...process.env,
  SDL_VIDEODRIVER: "dummy",
  SDL_AUDIODRIVER: "dummy",
  SDL_RENDER_DRIVER: "software",
};
const moduleData = Buffer.alloc(1280 * 1024);
for (let index = 0; index < moduleData.length; index++) {
  moduleData[index] = (index * 17 + Math.floor(index / 256)) & 255;
}
function moduleDataSource(path) {
  return `package main

module_data := #load(${JSON.stringify(path.replaceAll("\\", "/"))})

@(export)
game_module_data :: proc "c" (index: u32) -> u32 {
    if index >= u32(len(module_data)) {
        return 256
    }
    return u32(module_data[index])
}
`;
}
function native(language, args, status = 0) {
  const result = spawnSync(resolve(projects[language], "build/native", nativePlayer), args, {
    env,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, status, result.stderr + result.stdout);
  return result;
}
for (const language of ["luau", "odin"]) {
  const project = resolve(root, language);
  await createProject(project, language);
  const manifest = JSON.parse(await readFile(resolve(project, "console.json"), "utf8"));
  manifest.title = `PNG ${language} Ω`;
  manifest.display = language === "luau" ? [320, 180] : [640, 360];
  await writeFile(resolve(project, "console.json"), JSON.stringify(manifest));
  await copyFile(`tests/sdk/game.${language}`, resolve(project, `src/main.${language}`));
  if (language === "odin") {
    const dataPath = resolve(project, "src/module-data.bin");
    await writeFile(dataPath, moduleData);
    await writeFile(
      resolve(project, "src/module-data.odin"),
      formatSource(moduleDataSource(dataPath), "module-data.odin"),
    );
  } else {
    const mainPath = resolve(project, "src/main.luau");
    const main = await readFile(mainPath, "utf8");
    const directiveEnd = main.indexOf("\n") + 1;
    const data = "a".repeat(300 * 1024);
    await writeFile(
      mainPath,
      `${main.slice(0, directiveEnd)}local moduleData = ${JSON.stringify(data)}\nassert(#moduleData == 307200 and string.byte(moduleData, 307200) == 97)\n${main.slice(directiveEnd)}`,
    );
  }
  const packed = await packProject(project);
  images[language] = await readFile(packed.cartridge);
  projects[language] = project;
  for (const platform of ["web", "native"]) {
    assert.deepEqual(
      images[language],
      await readFile(resolve(project, `build/${platform}/game.png`)),
    );
  }
  assert.equal(chunks(images[language]).filter(({ type }) => type === "caRt").length, 1);
  const raw =
    language === "luau"
      ? [
          "--game",
          resolve(project, "build/native/luau-executor.wasm"),
          "--source",
          resolve(project, "build/native/game.luau"),
        ]
      : ["--game", resolve(project, "build/native/game.wasm")];
  reports[language] = JSON.parse(native(language, [...raw, "--smoke"]).stdout);
  assert.deepEqual(
    JSON.parse(native(language, ["--game", packed.cartridge, "--smoke"]).stdout),
    reports[language],
  );
  assert.equal(
    JSON.parse(native(language, [packed.cartridge, "--check"]).stdout).hash,
    reports[language].hash,
  );
  assert.ok(reports[language].audioQueuedFrames > 0);
  // Prove the game is self-contained by removing its loose source/module.
  for (const platform of ["web", "native"]) {
    await unlink(
      resolve(project, `build/${platform}/${language === "luau" ? "game.luau" : "game.wasm"}`),
    );
  }
  assert.deepEqual(JSON.parse(native(language, ["--smoke"]).stdout), reports[language]);
}
const odinModule = await readFile(resolve(projects.odin, "build/generated/game.wasm"));
assert.ok(odinModule.length > 1024 * 1024, "compiled Odin data exceeds the former module limit");
const dataModule = await WebAssembly.instantiate(odinModule, { env: { sin: Math.sin } });
for (const index of [0, 1, 255, 256, moduleData.length - 1]) {
  assert.equal(dataModule.instance.exports.game_module_data(index), moduleData[index]);
}
assert.equal(dataModule.instance.exports.game_module_data(moduleData.length), 256);
assert.ok(dataModule.instance.exports.memory.buffer.byteLength <= 8 * 1024 * 1024);
const luauSource = await readFile(resolve(projects.luau, "build/generated/game.luau"));
assert.ok(luauSource.length > 256 * 1024, "bundled Luau data exceeds the former source limit");
const executor = await readFile(resolve(projects.luau, "build/web/luau-executor.wasm"));
assert.throws(() => inspectGuest(executor), /8 MiB maximum/);
const executorModule = inspectGuest(executor, undefined, { luauExecutor: true });
const executorImports = {
  env: Object.fromEntries(
    WebAssembly.Module.imports(executorModule).map(({ name }) => [
      name,
      name === "sin" ? Math.sin : () => 0,
    ]),
  ),
};
const sourceGame = new WebAssembly.Instance(executorModule, executorImports).exports;
sourceGame._initialize?.();
const smallSource = Buffer.from("return {}\n");
loadSource(sourceGame, smallSource);
assert.ok(sourceGame.memory.buffer.byteLength <= 8 * 1024 * 1024);
assert.equal(sourceGame.game_heap_bytes(), 0, "source storage does not consume the VM heap");
assert.equal(sourceGame.game_source_allocate(0), 0);
assert.equal(sourceGame.game_source_allocate(8 * 1024 * 1024 + 1), 0);
assert.ok(sourceGame.game_error_length() > 0);
assert.ok(sourceGame.game_source_allocate(smallSource.length - 1));
sourceGame.game_init();
assert.throws(() => checkExecutor(sourceGame), /invalid Luau source size/);
const legacySourceGame = new WebAssembly.Instance(executorModule, executorImports).exports;
legacySourceGame._initialize?.();
loadSource({ ...legacySourceGame, game_source_allocate: undefined }, smallSource);
assert.deepEqual(
  new Uint8Array(
    legacySourceGame.memory.buffer,
    legacySourceGame.game_source_buffer(),
    smallSource.length,
  ),
  new Uint8Array(smallSource),
);
assert.match(
  native(
    "odin",
    ["--game", resolve(projects.luau, "build/native/luau-executor.wasm"), "--check"],
    1,
  ).stderr,
  /8 MiB maximum|memory limits/,
);
const runtimeBytes = await readFile(resolve(projects.odin, "build/web/runtime.wasm"));
const runtime = (await WebAssembly.instantiate(runtimeBytes, { env: { sin: Math.sin } })).instance
  .exports;
for (const language of ["luau", "odin"]) {
  const cart = decodeCartridge(runtime, images[language]);
  assert.equal(cart.language, language);
  assert.equal(cart.title, `PNG ${language} Ω`);
  assert.deepEqual(
    cart.code,
    new Uint8Array(
      await readFile(
        resolve(
          projects[language],
          `build/generated/game.${language === "luau" ? "luau" : "wasm"}`,
        ),
      ),
    ),
  );
}
const assets = JSON.parse(await readFile(resolve(projects.odin, "assets.json"), "utf8"));
const cover = defaultCover({ title: "CUSTOM COVER", language: "odin", assets });
function unsignedLeb(value) {
  const bytes = [];
  do {
    const next = value % 128;
    value = Math.floor(value / 128);
    bytes.push(next | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}
function padModule(code, size) {
  const name = Buffer.from("size-boundary");
  for (let width = 1; width <= 5; width++) {
    const length = size - code.length - 1 - width;
    if (length > name.length + 1 && unsignedLeb(length).length === width) {
      return Buffer.concat([
        code,
        Buffer.from([0]),
        unsignedLeb(length),
        unsignedLeb(name.length),
        name,
        Buffer.alloc(length - name.length - 1),
      ]);
    }
  }
  throw new Error("Cannot pad Wasm module to boundary");
}
function padPng(image, size) {
  return Buffer.concat([
    image.subarray(0, -12),
    chunk("teSt", Buffer.alloc(size - image.length - 12)),
    image.subarray(-12),
  ]);
}
assert.equal(MAX_GAME_BYTES, 8 * 1024 * 1024);
assert.equal(MAX_LUAU_SOURCE_BYTES, 8 * 1024 * 1024);
assert.equal(PNG_LIMIT, 10 * 1024 * 1024);
const maximumModule = padModule(odinModule, 8 * 1024 * 1024);
assert.equal(maximumModule.length, 8 * 1024 * 1024);
assert.ok(WebAssembly.validate(maximumModule));
const cartridgeOptions = {
  title: "PNG odin Ω",
  language: "odin",
  display: [640, 360],
  code: maximumModule,
  cover,
  profile: JSON.parse(await readFile(resolve(projects.odin, "console.json"), "utf8")).profile,
};
const maximumImage = encodeCartridge(cartridgeOptions);
const maximumBaseImage = padPng(maximumImage, 10 * 1024 * 1024);
assert.equal(maximumBaseImage.length, 10 * 1024 * 1024);
assert.equal(decodeCartridge(runtime, maximumBaseImage).code.length, 8 * 1024 * 1024);
const maximumPath = resolve(projects.odin, "build/web/maximum.png");
await writeFile(maximumPath, maximumBaseImage);
assert.deepEqual(JSON.parse(native("odin", [maximumPath, "--smoke"]).stdout), reports.odin);
assert.throws(
  () => encodeCartridge({ ...cartridgeOptions, code: padModule(odinModule, 8 * 1024 * 1024 + 1) }),
  /code size/,
);
assert.throws(
  () => encodeCartridge({ ...cartridgeOptions, cover: padPng(cover, 10 * 1024 * 1024) }),
  /base size limit \(10485760 bytes\)/,
);
const maximumLuau = Buffer.concat([
  luauSource,
  Buffer.from("\n--"),
  Buffer.alloc(8 * 1024 * 1024 - luauSource.length - 3, 120),
]);
const luauOptions = {
  ...cartridgeOptions,
  title: "PNG luau Ω",
  language: "luau",
  display: [320, 180],
  code: maximumLuau,
};
const maximumLuauImage = encodeCartridge(luauOptions);
assert.equal(decodeCartridge(runtime, maximumLuauImage).code.length, 8 * 1024 * 1024);
const maximumLuauPath = resolve(projects.luau, "build/web/maximum.png");
await writeFile(maximumLuauPath, maximumLuauImage);
const luauMaximumReport = JSON.parse(native("luau", [maximumLuauPath, "--smoke"]).stdout);
assert.equal(luauMaximumReport.hash, reports.luau.hash);
assert.equal(luauMaximumReport.sounds, reports.luau.sounds);
const maximumSourcePath = resolve(root, "maximum.luau");
await writeFile(maximumSourcePath, maximumLuau);
assert.equal(
  JSON.parse(
    native("luau", [
      "--game",
      resolve(projects.luau, "build/native/luau-executor.wasm"),
      "--source",
      maximumSourcePath,
      "--smoke",
    ]).stdout,
  ).hash,
  reports.luau.hash,
);
const legacyExecutor = Buffer.from(executor);
const allocationExport = legacyExecutor.indexOf("game_source_allocate");
assert.ok(allocationExport > 0);
legacyExecutor[allocationExport] = "X".charCodeAt(0);
assert.ok(
  !WebAssembly.Module.exports(new WebAssembly.Module(legacyExecutor)).some(
    ({ name }) => name === "game_source_allocate",
  ),
);
const legacyExecutorPath = resolve(root, "legacy-executor.wasm");
await writeFile(legacyExecutorPath, legacyExecutor);
assert.equal(
  JSON.parse(
    native("luau", ["--game", legacyExecutorPath, "--source", maximumSourcePath, "--smoke"]).stdout,
  ).hash,
  reports.luau.hash,
);
const oversizedEntry = resolve(projects.luau, "oversized.luau");
const bundleOptions = {
  entry: oversizedEntry,
  project: projects.luau,
  sdkRoot: resolve("sdk/luau"),
  assets: Buffer.alloc(0),
};
await writeFile(oversizedEntry, Buffer.alloc(8 * 1024 * 1024 + 1, 120));
await assert.rejects(() => bundleLuau(bundleOptions), /module graph exceeds/);
await writeFile(
  oversizedEntry,
  Buffer.concat([Buffer.from("--"), Buffer.alloc(8 * 1024 * 1024 - 2, 120)]),
);
await assert.rejects(() => bundleLuau(bundleOptions), /Bundled Luau source exceeds size limit/);
assert.throws(
  () => encodeCartridge({ ...luauOptions, code: Buffer.concat([maximumLuau, Buffer.from("x")]) }),
  /code size/,
);
await writeFile(resolve(root, "cover.png"), cover);
const output = resolve(root, "shared.png");
const cli = spawnSync(
  process.execPath,
  [
    "tools/byt.mjs",
    "pack",
    projects.odin,
    "--cover",
    resolve(root, "cover.png"),
    "--output",
    output,
  ],
  { encoding: "utf8", timeout: 60000 },
);
assert.ifError(cli.error);
assert.equal(cli.status, 0, cli.stderr + cli.stdout);
const custom = await readFile(output);
assert.equal(decodeCartridge(runtime, custom).title, "PNG odin Ω");
assert.deepEqual(
  chunks(custom).find(({ type }) => type === "IDAT").data,
  chunks(cover).find(({ type }) => type === "IDAT").data,
);
for (const platform of ["web", "native"]) {
  await unlink(resolve(projects.odin, `build/${platform}/game.wasm`));
}

const original = images.odin,
  parts = chunks(original);
const payload = parts.find(({ type }) => type === "caRt").data;
function replacePayload(edit) {
  const data = Buffer.from(payload);
  edit(data);
  return Buffer.concat([
    signature,
    ...parts.map((part) => chunk(part.type, part.type === "caRt" ? data : part.data)),
  ]);
}
const excessiveModule = padModule(odinModule, 8 * 1024 * 1024 + 1);
const excessivePayload = Buffer.concat([
  payload.subarray(0, 32 + payload.readUInt32LE(20)),
  excessiveModule,
]);
excessivePayload.writeUInt32LE(excessiveModule.length, 24);
const excessiveCodeImage = Buffer.concat([
  signature,
  ...parts.map((part) => chunk(part.type, part.type === "caRt" ? excessivePayload : part.data)),
]);
const excessiveModulePath = resolve(projects.odin, "build/web/oversized.wasm");
await writeFile(excessiveModulePath, excessiveModule);
assert.match(native("odin", [excessiveModulePath, "--check"], 1).stderr, /module exceeds/);
const corruptCRC = Buffer.from(original);
corruptCRC[parts.find(({ type }) => type === "caRt").offset + 9] ^= 1;
const malformed = [
  ["signature", Buffer.from("not a png"), /signature/],
  ["truncated", original.subarray(0, -1), /outside|truncated/],
  ["trailing", Buffer.concat([original, Buffer.from([0])]), /end chunk/],
  ["checksum", corruptCRC, /checksum/],
  ["version", replacePayload((b) => b.writeUInt16LE(2, 4)), /unsupported/],
  ["language", replacePayload((b) => (b[6] = 9)), /language/],
  ["profile", replacePayload((b) => (b[7] = 99)), /unsupported/],
  ["sdk", replacePayload((b) => b.writeUInt32LE(999, 8)), /unsupported/],
  ["abi", replacePayload((b) => b.writeUInt32LE(99, 12)), /unsupported/],
  ["flags", replacePayload((b) => b.writeUInt32LE(1, 28)), /unsupported/],
  ["display", replacePayload((b) => b.writeUInt16LE(123, 16)), /display/],
  ["length", replacePayload((b) => b.writeUInt32LE(0xffffffff, 24)), /length/],
  ["title-size", replacePayload((b) => b.writeUInt32LE(129, 20)), /length/],
  ["title-control", replacePayload((b) => (b[32] = 0)), /title/],
  ["title-utf8", replacePayload((b) => (b[32] = 0xff)), /encoding/],
  ["wasm-header", replacePayload((b) => (b[32 + b.readUInt32LE(20)] = 1)), /Wasm/],
  [
    "duplicate",
    Buffer.concat([original.subarray(0, -12), chunk("caRt", payload), original.subarray(-12)]),
    /duplicate/,
  ],
  ["missing-payload", cover, /no cartridge/],
  [
    "critical",
    Buffer.concat([
      original.subarray(0, -12),
      chunk("ABCD", Buffer.alloc(0)),
      original.subarray(-12),
    ]),
    /critical/,
  ],
  ["oversize-code", excessiveCodeImage, /code length/],
  ["oversize", padPng(maximumImage, 10 * 1024 * 1024 + 1), /size|base limit/],
];
const luauParts = chunks(maximumLuauImage);
const luauPayload = luauParts.find(({ type }) => type === "caRt").data;
const excessiveLuauPayload = Buffer.concat([luauPayload, Buffer.from("x")]);
excessiveLuauPayload.writeUInt32LE(8 * 1024 * 1024 + 1, 24);
malformed.push([
  "oversize-luau",
  Buffer.concat([
    signature,
    ...luauParts.map((part) =>
      chunk(part.type, part.type === "caRt" ? excessiveLuauPayload : part.data),
    ),
  ]),
  /code length/,
]);
for (const [name, bytes, message] of malformed) {
  assert.throws(() => decodeCartridge(runtime, bytes), message, name);
  const file = resolve(root, `${name}.png`);
  await writeFile(file, bytes);
  assert.match(native("odin", ["--game", file, "--check"], 1).stderr, message, name);
}
const mismatch = replacePayload((b) => {
  b.writeUInt16LE(320, 16);
  b.writeUInt16LE(180, 18);
});
await writeFile(resolve(root, "mismatch.png"), mismatch);
assert.match(
  native("odin", ["--game", resolve(root, "mismatch.png"), "--check"], 1).stderr,
  /initial display/,
);
const noSdk = replacePayload((b) => {
  const offset = b.indexOf("game_sdk_version", 32 + b.readUInt32LE(20));
  assert.ok(offset > 0);
  b[offset + "game_sdk_version".length - 1] = 120;
});
await writeFile(resolve(root, "missing-sdk.png"), noSdk);
assert.match(
  native("odin", ["--game", resolve(root, "missing-sdk.png"), "--check"], 1).stderr,
  /export/,
);

const server = serve(root, 0);
await once(server, "listening");
const browser = await chromium.launch({
  channel: process.env.PLAYER_BROWSER_CHANNEL || "chrome",
  headless: true,
});
try {
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const language of ["luau", "odin"]) {
    await page.goto(`${base}/${language}/build/web/debug.html?game=./game.png&smoke`);
    await page.waitForFunction(() => playerStatus.ready || playerStatus.error);
    assert.equal(await page.evaluate(() => playerStatus.error), "");
    assert.equal(await page.title(), `PNG ${language} Ω`);
    assert.equal(await page.evaluate(() => playerStatus.width), language === "luau" ? 320 : 640);
    await page.locator("#start").click();
    await page.waitForFunction(() => playerStatus.ticks >= 120 || playerStatus.error);
    assert.equal(await page.evaluate(() => playerStatus.hash), reports[language].hash);
    assert.equal(await page.evaluate(() => playerStatus.sounds), reports[language].sounds);
    assert.ok(await page.evaluate(() => playerAudio.played > 0 && playerAudio.peak > 0));
    assert.deepEqual(
      await page.evaluate(async () => {
        const img = new Image();
        img.src = "./game.png";
        await img.decode();
        return [img.naturalWidth, img.naturalHeight];
      }),
      [256, 256],
    );
    await page.screenshot({ path: resolve(root, `${language}.png`) });
  }
  await page.goto(`${base}/odin/build/web/debug.html?game=./maximum.png&smoke`);
  await page.waitForFunction(() => playerStatus.ready || playerStatus.error);
  assert.equal(await page.evaluate(() => playerStatus.error), "");
  await page.locator("#start").click();
  await page.waitForFunction(() => playerStatus.ticks >= 120 || playerStatus.error);
  assert.equal(await page.evaluate(() => playerStatus.hash), reports.odin.hash);
  assert.equal(await page.evaluate(() => playerStatus.sounds), reports.odin.sounds);
  await page.goto(`${base}/luau/build/web/debug.html?game=./maximum.png&smoke`);
  await page.waitForFunction(() => playerStatus.ready || playerStatus.error);
  assert.equal(await page.evaluate(() => playerStatus.error), "");
  await page.locator("#start").click();
  await page.waitForFunction(() => playerStatus.ticks >= 120 || playerStatus.error);
  assert.equal(await page.evaluate(() => playerStatus.hash), reports.luau.hash);
  assert.equal(await page.evaluate(() => playerStatus.sounds), reports.luau.sounds);
  await page.goto(`${base}/odin/build/web/debug.html?game=./oversized.wasm&smoke`);
  await page.waitForFunction(() => !!playerStatus.error);
  assert.match(await page.evaluate(() => playerStatus.error), /Module or PNG exceeds/);
  await page.goto(`${base}/luau/build/web/debug.html?smoke`);
  await page.waitForFunction(() => playerStatus.ready || playerStatus.error);
  for (const [name, bytes, message] of [
    ...malformed,
    ["mismatch", mismatch, /initial display/],
    ["missing-sdk", noSdk, /SDK/],
  ]) {
    await page.evaluate(() => (playerStatus.error = ""));
    await page
      .locator("#cartridge")
      .setInputFiles({ name: `${name}.png`, mimeType: "image/png", buffer: bytes });
    await page.waitForFunction(() => !!playerStatus.error);
    assert.match(await page.evaluate(() => playerStatus.error), message, name);
  }
  for (const language of ["odin", "luau"]) {
    await page.evaluate(() => (playerStatus.error = ""));
    await page
      .locator("#cartridge")
      .setInputFiles({ name: `${language}.png`, mimeType: "image/png", buffer: images[language] });
    await page.waitForFunction(() => playerStatus.ready || playerStatus.error);
    assert.equal(await page.evaluate(() => playerStatus.error), "");
    assert.equal(await page.title(), `PNG ${language} Ω`);
    await page.locator("#start").click();
    await page.waitForFunction(() => playerStatus.ticks >= 120 || playerStatus.error);
    assert.equal(await page.evaluate(() => playerStatus.hash), reports[language].hash);
  }
  assert.equal(await page.evaluate(() => playerStatus.startup.executorCache.hit), true);
  await page.evaluate(
    (bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], "dropped.png", { type: "image/png" }));
      window.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer }));
    },
    [...images.odin],
  );
  await page.waitForFunction(() => playerStatus.ready && document.title === "PNG odin Ω");
  assert.equal(await page.evaluate(() => playerStatus.ticks), 0);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
console.log(
  `PNG cartridges passed: both languages above their former code limits, exact 8 MiB module/source and 10 MiB base bounds, oversized rejection, native/browser parity and audio, custom/default viewable covers, URL/file/drop loading, executor reuse, and ${malformed.length + 2} malformed or incompatible cases.`,
);
