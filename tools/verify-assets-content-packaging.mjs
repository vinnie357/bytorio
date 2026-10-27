import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createProject, buildProject, repo } from "./sdk/project.mjs";
import { readGraphics } from "./sdk/assets.mjs";
import { bundleLuau } from "./sdk/bundle.mjs";
import { chunks, encodeCartridge } from "./sdk/cartridge.mjs";

const contract = JSON.parse(await readFile(resolve(repo, "sdk/contract.json"), "utf8"));
const limits = contract.cartridge.content;
const root = resolve("build/assets-content-packaging", randomUUID());
await mkdir(root, { recursive: true });

async function fixture(name, edit = () => {}) {
  const project = resolve(root, name);
  await createProject(project, "luau");
  const manifestPath = resolve(project, "console.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await edit(manifest, project);
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { project, manifest };
}

function contentEntries(image) {
  const payload = chunks(image).find(({ type }) => type === "coNt")?.data;
  assert.ok(payload, "assetsContent must add a coNt chunk");
  const count = payload.readUInt32LE(limits.headerFields.count);
  const dataStart = limits.headerBytes + count * limits.recordBytes;
  return Array.from({ length: count }, (_, index) => {
    const record = limits.headerBytes + index * limits.recordBytes;
    const id = payload.readUInt32LE(record + limits.recordFields.id);
    const offset = payload.readUInt32LE(record + limits.recordFields.offset);
    const length = payload.readUInt32LE(record + limits.recordFields.length);
    return { id, bytes: payload.subarray(dataStart + offset, dataStart + offset + length) };
  });
}

test("assetsContent packages the exact graphics packet beside listed content", async () => {
  const listed = Buffer.from([17, 23, 41, 89]);
  const { project, manifest } = await fixture("packet", async (value, directory) => {
    value.assetsContent = 0xffffffff;
    value.content = [{ id: 7, path: "listed.bin" }];
    await writeFile(resolve(directory, "listed.bin"), listed);
  });
  const { packet } = await readGraphics(resolve(project, manifest.assets));
  await buildProject(project);
  const entries = contentEntries(await readFile(resolve(project, "build/game.png")));
  assert.deepEqual(entries, [
    { id: 7, bytes: listed },
    { id: 0xffffffff, bytes: packet },
  ]);
});

test("assetsContent packaging forwards the id to the generated bundle", async () => {
  const { project, manifest } = await fixture("bundle", (value) => {
    value.assetsContent = 731;
  });
  const { packet } = await readGraphics(resolve(project, manifest.assets));
  await buildProject(project);
  const source = await readFile(resolve(project, "build/generated/game.luau"), "utf8");
  assert.ok(source.includes("__sdk.assets(731)"), "packaging must bundle the content id");
  assert.ok(!source.includes(packet.toString("base64")), "packaging must omit the base64 packet");
});

test("without assetsContent packaging preserves legacy cartridge bytes", async () => {
  const { project, manifest } = await fixture("legacy", async (value, directory) => {
    value.content = [{ id: 7, path: "listed.bin" }];
    await writeFile(resolve(directory, "listed.bin"), Buffer.from([17, 23, 41, 89]));
  });
  const spec = await buildProject(project);
  const { packet } = await readGraphics(spec.assets);
  const source = await bundleLuau({
    entry: spec.entry,
    project,
    sdkRoot: resolve(repo, "sdk/luau"),
    assets: packet,
    display: spec.display,
    profile: spec.profileId,
  });
  assert.ok(source.includes(packet.toString("base64")), "legacy bundle embeds the packet");
  const expected = encodeCartridge({
    title: manifest.title,
    language: "luau",
    profile: spec.profile,
    display: manifest.display,
    code: Buffer.from(source),
    assets: JSON.parse(await readFile(spec.assets, "utf8")),
    cover: spec.cover ? await readFile(spec.cover) : null,
    content: [{ id: 7, bytes: Buffer.from([17, 23, 41, 89]) }],
    save: manifest.save,
  });
  assert.deepEqual(await readFile(resolve(project, "build/game.png")), expected);
});

test("assetsContent fits exactly at the content entry limit", async () => {
  const { project } = await fixture("entry-boundary", async (value, directory) => {
    value.assetsContent = 0xffffffff;
    value.content = Array.from({ length: limits.maxEntries - 1 }, (_, index) => ({
      id: index + 1,
      path: "one.bin",
    }));
    await writeFile(resolve(directory, "one.bin"), Buffer.from([37]));
  });
  await buildProject(project);
  const entries = contentEntries(await readFile(resolve(project, "build/game.png")));
  assert.equal(entries.length, limits.maxEntries, "entry limit includes the graphics packet");
  assert.equal(entries.at(-1).id, 0xffffffff);
});

test("assetsContent exceeding the content entry limit is rejected", async () => {
  const { project } = await fixture("entry-overflow", async (value, directory) => {
    value.assetsContent = 0xffffffff;
    value.content = Array.from({ length: limits.maxEntries }, (_, index) => ({
      id: index + 1,
      path: "one.bin",
    }));
    await writeFile(resolve(directory, "one.bin"), Buffer.from([37]));
  });
  await assert.rejects(buildProject(project), /content.*(?:entry limit|entries)/i);
});

test("content byte limit includes the graphics packet and its index record", async () => {
  const { project } = await fixture("byte-overflow", async (value, directory) => {
    value.assetsContent = 0xffffffff;
    value.content = [{ id: 7, path: "large.bin" }];
    const { packet } = await readGraphics(resolve(directory, value.assets));
    const file = await open(resolve(directory, "large.bin"), "w");
    try {
      // One byte over only when both graphics bytes and the second record count.
      await file.truncate(
        limits.maxBytes - limits.headerBytes - 2 * limits.recordBytes - packet.length + 1,
      );
    } finally {
      await file.close();
    }
  });
  await assert.rejects(buildProject(project), /content.*byte limit/i);
});
