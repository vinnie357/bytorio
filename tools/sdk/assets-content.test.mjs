import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { bundleLuau } from "./bundle.mjs";
import { readGraphics } from "./assets.mjs";
import { encodeCartridge } from "./cartridge.mjs";
import { manifest, syncEditor } from "./project.mjs";
import { timedSpawnSync as spawnSync } from "../command-timing.mjs";
import { tool } from "../toolchain.mjs";

await mkdir("build", { recursive: true });
const root = await mkdtemp(resolve("build/assets-content-unit-"));
const sdkRoot = resolve(root, "sdk");
const assets = {
  palette: Array.from({ length: 16 }, (_, i) => `#${i.toString(16).repeat(6)}`),
  sprites: [Array.from({ length: 16 }, () => "0123456789abcdef")],
  font: { A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"] },
};
await mkdir(sdkRoot);
await writeFile(resolve(sdkRoot, "bytorio.luau"), "return {}\n");
await writeFile(resolve(root, "main.luau"), "return {}\n");
await writeFile(resolve(root, "assets.json"), JSON.stringify(assets));
const { packet } = await readGraphics(resolve(root, "assets.json"));
const bundleOptions = {
  project: root,
  entry: resolve(root, "main.luau"),
  sdkRoot,
  assets: packet,
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

after(async () => {
  assert.equal(dirname(root), resolve("build"));
  await rm(root, { recursive: true, force: true });
});

for (const id of [1, 37, 0xffffffff]) {
  test(`assetsContent ${id} bundles a content reference without the base64 packet`, async () => {
    const source = (await bundleLuau({ ...bundleOptions, assetsContent: id })).toString("utf8");
    assert.ok(source.includes(`__sdk.assets(${id})`), `missing __sdk.assets(${id})`);
    assert.ok(!source.includes(packet.toString("base64")), "packet must stay out of bundled code");
  });
}

test("assetsContent excludes the graphics packet from bundled source", async () => {
  const source = await bundleLuau({ ...bundleOptions, assetsContent: 37 });
  assert.ok(
    !source.includes(Buffer.from(packet.toString("base64"))),
    "assetsContent still embeds the base64 graphics packet",
  );
});

test("omitting assetsContent preserves the legacy bundle and cartridge bytes", async () => {
  const code = await bundleLuau(bundleOptions);
  assert.ok(code.includes(Buffer.from(packet.toString("base64"))));
  const cartridge = encodeCartridge({
    title: "Assets content compatibility",
    language: "luau",
    display: [640, 360],
    code,
    assets,
  });
  assert.deepEqual(
    { bundle: digest(code), cartridge: digest(cartridge) },
    {
      bundle: "d09e12e5c07ba1b9d2b03189b16cc8e54afce6c235e5e9a934b3a1a910ef675b",
      cartridge: "cc0d8a82fa3751361c3c86bd24bff13f0caac0dffd5581b4d7dac88fc6ee5339",
    },
  );
});

async function project(name, changes) {
  const path = resolve(root, name);
  await mkdir(path);
  await writeFile(resolve(path, "main.luau"), "return {}\n");
  await writeFile(resolve(path, "assets.json"), JSON.stringify(assets));
  await writeFile(resolve(path, "listed.bin"), Buffer.from([1, 2, 3]));
  await writeFile(
    resolve(path, "console.json"),
    JSON.stringify({
      sdk: "0.1.0",
      language: "luau",
      display: [640, 360],
      entry: "main.luau",
      assets: "assets.json",
      ...changes,
    }),
  );
  return path;
}

for (const [index, id] of [0, -1, 1.5, 0x100000000, "37", null, false, {}, []].entries()) {
  test(`manifest rejects invalid assetsContent ${JSON.stringify(id)}`, async () => {
    const path = await project(`invalid-${index}`, { assetsContent: id });
    await assert.rejects(() => manifest(path), /assetsContent.*(?:id|integer|u32|positive)/i);
  });
}

for (const id of [1, 0xffffffff]) {
  test(`manifest accepts assetsContent boundary id ${id}`, async () => {
    const path = await project(`boundary-${id}`, { assetsContent: id });
    assert.equal((await manifest(path)).assetsContent, id);
  });
}

test("manifest rejects assetsContent colliding with a listed content id", async () => {
  const path = await project("collision", {
    assetsContent: 37,
    content: [{ id: 37, path: "listed.bin" }],
  });
  await assert.rejects(() => manifest(path), /assetsContent.*(?:colli|duplicate|unique|content)/i);
});

test("manifest rejects assetsContent on Odin projects", async () => {
  const path = await project("odin", { language: "odin", assetsContent: 37 });
  await assert.rejects(() => manifest(path), /assetsContent.*(?:Odin|Luau)/i);
});

for (const [name, source] of [
  ["string", '"R0ZYMQ=="'],
  ["buffer", "buffer.create(16)"],
  ["number", "37"],
]) {
  test(`synced Luau editor declarations accept byt.assets(${name})`, async () => {
    const path = await project(`editor-${name}`, {});
    await syncEditor(path);
    const entry = resolve(path, "main.luau");
    await writeFile(
      entry,
      `--!strict\nlocal byt=require("@bytorio")\nbyt.assets(${source})\nreturn {}\n`,
    );
    const result = spawnSync(tool("luau-analyze"), ["--solver=new", entry], {
      cwd: path,
      encoding: "utf8",
      timeout: 30000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
  });
}

test("synced native graphics bridge declarations accept raw packet buffers", async () => {
  const path = await project("editor-native", {});
  await syncEditor(path);
  const entry = resolve(path, "main.luau");
  await writeFile(
    entry,
    '--!strict\nlocal native=require("./.bytorio/native")\nnative.graphics_assets(buffer.create(16))\nreturn {}\n',
  );
  const result = spawnSync(tool("luau-analyze"), ["--solver=new", entry], {
    cwd: path,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
