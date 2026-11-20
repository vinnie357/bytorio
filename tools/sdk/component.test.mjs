import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { Header } from "tar";
import { componentPath, packComponent, unpackComponent, verifyComponent } from "./component.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(run) {
  const root = await mkdtemp(resolve(tmpdir(), "byt-component-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function tarBytes(entries) {
  const parts = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data || "");
    const header = Buffer.alloc(512);
    new Header({ path: entry.path, size: data.length, mode: 0o644, type: "File", ...entry }).encode(
      header,
    );
    parts.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

function inventoryOf(files = [{ path: "licenses/sdk.txt", data: "SDK notice" }]) {
  return Buffer.from(
    JSON.stringify({
      schema: 1,
      files: files.map(({ path, data }) => ({
        path,
        bytes: Buffer.byteLength(data),
        mode: 0o644,
        sha256: digest(Buffer.from(data)),
      })),
      notices: ["licenses/sdk.txt"],
    }) + "\n",
  );
}

function descriptorOf(archive, inventory, files = 1, expandedBytes = inventory.length + 10) {
  return {
    format: "tar.gz",
    bytes: archive.length,
    sha256: digest(archive),
    inventorySha256: digest(inventory),
    files,
    expandedBytes,
  };
}

test("components preserve binary bytes, notices, executable modes and deterministic archives", async () =>
  fixture(async (root) => {
    const source = resolve(root, "source");
    await mkdir(resolve(source, "licenses"), { recursive: true });
    const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await writeFile(resolve(source, "byt-helper"), binary);
    await writeFile(resolve(source, "licenses/sdk.txt"), "SDK notice");
    const archive = resolve(root, "component.tar.gz");
    const descriptor = await packComponent({
      root: source,
      archive,
      executables: ["byt-helper"],
      notices: ["licenses/sdk.txt"],
    });
    const again = await packComponent({
      root: source,
      archive: resolve(root, "again.tar.gz"),
      executables: ["byt-helper"],
      notices: ["licenses/sdk.txt"],
    });
    assert.deepEqual(again, descriptor);
    await assert.rejects(
      packComponent({
        root: source,
        archive,
        executables: ["byt-helper"],
        notices: ["licenses/sdk.txt"],
      }),
      /EEXIST/,
    );
    const destination = resolve(root, "installed payload");
    const inventory = await unpackComponent({ archive, destination, descriptor });
    assert.deepEqual(await readFile(resolve(destination, "byt-helper")), binary);
    assert.equal(inventory.files.find((file) => file.path === "byt-helper").mode, 0o755);
    assert.deepEqual(inventory.notices, ["licenses/sdk.txt"]);
    await verifyComponent(destination, descriptor);
    await writeFile(resolve(destination, "unexpected"), "unlisted");
    await assert.rejects(verifyComponent(destination, descriptor), /unexpected files/);
    await rm(resolve(destination, "unexpected"));
    await assert.rejects(unpackComponent({ archive, destination, descriptor }), /EEXIST/);
    await writeFile(resolve(destination, "byt-helper"), "corrupt");
    await assert.rejects(
      verifyComponent(destination, descriptor),
      /checksum, size or mode mismatch/,
    );
  }));

test("component paths reject traversal, platform aliases and unsupported names", () => {
  for (const name of [
    "../escape",
    "/absolute",
    "a/../b",
    "a//b",
    "a/./b",
    "a\\b",
    "C:/drive",
    "a:stream",
    "nul.txt",
    "COM1",
    "lpt9.dat",
    "a.",
    "a ",
    "a\0b",
    "a\nb",
  ]) {
    assert.throws(() => componentPath(name), /Invalid SDK component path/, name);
  }
  assert.equal(componentPath("lib/My Module (1)/tool.dylib"), "lib/My Module (1)/tool.dylib");
});

test("corrupt payloads and conflicting directory names are rejected without leaving an installation", async () =>
  fixture(async (root) => {
    for (const [index, files] of [
      [{ path: "licenses/sdk.txt", data: "SDK notice" }],
      [
        { path: "licenses/sdk.txt", data: "SDK notice" },
        { path: "a", data: "one" },
        { path: "a/b", data: "two" },
      ],
      [
        { path: "licenses/sdk.txt", data: "SDK notice" },
        { path: "Lib/a", data: "one" },
        { path: "lib/b", data: "two" },
      ],
    ].entries()) {
      const inventory = inventoryOf(files);
      const entries = files.map((file) => ({ ...file }));
      if (index === 0) {
        entries[0].data = "bad notice";
      }
      const bytes = tarBytes([{ path: "sdk-component.json", data: inventory }, ...entries]);
      const archive = resolve(root, `${index}.tar.gz`);
      await writeFile(archive, bytes);
      const destination = resolve(root, `install-${index}`);
      await assert.rejects(
        unpackComponent({
          archive,
          destination,
          descriptor: descriptorOf(
            bytes,
            inventory,
            files.length,
            inventory.length + files.reduce((sum, file) => sum + Buffer.byteLength(file.data), 0),
          ),
        }),
        /checksum, size or mode mismatch|parent directory|differ only by case/,
      );
      await assert.rejects(readFile(resolve(destination, "sdk-component.json")), {
        code: "ENOENT",
      });
    }
  }));

test("unsafe entries, links, duplicate names and file/directory conflicts never publish", async () =>
  fixture(async (root) => {
    const inventory = inventoryOf();
    const baseline = [
      { path: "sdk-component.json", data: inventory },
      { path: "licenses/sdk.txt", data: "SDK notice" },
    ];
    for (const [index, extra] of [
      { path: "../escape", data: "bad" },
      { path: "/absolute", data: "bad" },
      { path: "NUL", data: "bad" },
      { path: "license-link", type: "SymbolicLink", linkpath: "../escape" },
      { path: "license-link", type: "Link", linkpath: "licenses/sdk.txt" },
      { path: "licenses/SDK.txt", data: "bad" },
      { path: "licenses/sdk.txt", data: "bad" },
      { path: "named-pipe", type: "FIFO" },
    ].entries()) {
      const archiveBytes = tarBytes([...baseline, extra]);
      const archive = resolve(root, `${index}.tar.gz`);
      await writeFile(archive, archiveBytes);
      const destination = resolve(root, `install-${index}`);
      await assert.rejects(
        unpackComponent({
          archive,
          destination,
          descriptor: descriptorOf(archiveBytes, inventory),
        }),
      );
      await assert.rejects(readFile(resolve(root, "escape")), { code: "ENOENT" });
      await assert.rejects(readFile(resolve(destination, "licenses/sdk.txt")), { code: "ENOENT" });
    }
  }));

test("archive checksums, declared bounds and internal inventories are independently enforced", async () =>
  fixture(async (root) => {
    const inventory = inventoryOf();
    const archiveBytes = tarBytes([
      { path: "sdk-component.json", data: inventory },
      { path: "licenses/sdk.txt", data: "SDK notice" },
    ]);
    const archive = resolve(root, "test.tar.gz");
    await writeFile(archive, archiveBytes);
    const descriptor = descriptorOf(archiveBytes, inventory);
    for (const override of [
      { sha256: "0".repeat(64) },
      { bytes: archiveBytes.length + 1 },
      { inventorySha256: "0".repeat(64) },
      { expandedBytes: descriptor.expandedBytes - 1 },
      { files: 2 },
    ]) {
      const destination = resolve(root, "failed");
      await assert.rejects(
        unpackComponent({ archive, destination, descriptor: { ...descriptor, ...override } }),
      );
      await assert.rejects(readFile(resolve(destination, "licenses/sdk.txt")), { code: "ENOENT" });
    }
    const truncated = archiveBytes.subarray(0, -8);
    await writeFile(archive, truncated);
    await assert.rejects(
      unpackComponent({
        archive,
        destination: resolve(root, "truncated"),
        descriptor: { ...descriptor, bytes: truncated.length, sha256: digest(truncated) },
      }),
    );
  }));
