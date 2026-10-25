import { nativePlayer } from "./toolchain.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, copyFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { chromium } from "./browser-timing.mjs";
import { createProject, packProject } from "./sdk/project.mjs";
import { chunks, chunk, signature, PNG_LIMIT, defaultCover } from "./sdk/cartridge.mjs";
import { decodeCartridge } from "../runtime/odin/web/cartridge.js";
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
  ["oversize", Buffer.alloc(PNG_LIMIT + 1), /size|2 MiB/],
];
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
    await page.goto(`${base}/${language}/build/web/player.html?game=./game.png&smoke`);
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
  await page.goto(`${base}/luau/build/web/player.html?smoke`);
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
  `PNG cartridges passed: both languages, native/browser parity and audio, custom/default viewable covers, URL/file/drop loading, executor reuse, and ${malformed.length + 2} malformed or incompatible cases.`,
);
