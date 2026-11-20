import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { create, list } from "tar";

const inventoryName = "sdk-component.json";
const maxArchiveBytes = 1024 * 1024 * 1024;
const maxExpandedBytes = 2 * 1024 * 1024 * 1024;
const maxFiles = 50000;
const maxInventoryBytes = 16 * 1024 * 1024;
const checksum = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function componentPath(value) {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !/^[a-zA-Z0-9_./ @()+,-]+$/.test(value) ||
    value.includes("\\") ||
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      )
  ) {
    throw new Error(`Invalid SDK component path: ${value}`);
  }
  return value;
}

export function componentDescriptor(value) {
  if (
    !value ||
    value.format !== "tar.gz" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > maxArchiveBytes ||
    !Number.isSafeInteger(value.expandedBytes) ||
    value.expandedBytes < 1 ||
    value.expandedBytes > maxExpandedBytes ||
    !Number.isSafeInteger(value.files) ||
    value.files < 1 ||
    value.files > maxFiles ||
    !checksum(value.sha256) ||
    !checksum(value.inventorySha256)
  ) {
    throw new Error("Invalid SDK component descriptor");
  }
  return value;
}

async function fileDigest(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}

export function validateComponentPaths(paths) {
  const files = new Set();
  const directories = new Map();
  for (const path of paths) {
    componentPath(path);
    const key = path.toLowerCase();
    if (files.has(key)) {
      throw new Error("Duplicate SDK component path");
    }
    files.add(key);
    const parts = path.split("/");
    while (parts.length > 1) {
      parts.pop();
      const directory = parts.join("/");
      const key = directory.toLowerCase();
      if (directories.has(key) && directories.get(key) !== directory) {
        throw new Error("SDK component directory names differ only by case");
      }
      directories.set(key, directory);
    }
  }
  if ([...directories.keys()].some((name) => files.has(name))) {
    throw new Error("SDK component file conflicts with a parent directory");
  }
}

async function filesUnder(root, prefix = "") {
  if (!prefix && !(await lstat(root)).isDirectory()) {
    throw new Error("SDK component root must be a directory, without a symlink");
  }
  const result = [];
  for (const entry of (await readdir(resolve(root, prefix), { withFileTypes: true })).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )) {
    const path = componentPath(prefix ? `${prefix}/${entry.name}` : entry.name);
    if (entry.isDirectory()) {
      result.push(...(await filesUnder(root, path)));
    } else if (entry.isFile()) {
      result.push(path);
    } else {
      throw new Error(`SDK components cannot contain links or special files: ${path}`);
    }
    if (result.length > maxFiles + 1) {
      throw new Error("SDK component exceeds file count limit");
    }
  }
  return result;
}

function validateInventory(bytes, descriptor) {
  if (bytes.length > maxInventoryBytes || hash(bytes) !== descriptor.inventorySha256) {
    throw new Error("SDK component inventory checksum or size mismatch");
  }
  const value = JSON.parse(bytes.toString("utf8"));
  if (
    value.schema !== 1 ||
    !Array.isArray(value.files) ||
    value.files.length !== descriptor.files ||
    !Array.isArray(value.notices) ||
    !value.notices.length
  ) {
    throw new Error("Invalid SDK component inventory");
  }
  const names = new Map();
  validateComponentPaths(value.files.map((file) => file.path));
  let expanded = bytes.length;
  for (const file of value.files) {
    componentPath(file.path);
    const key = file.path.toLowerCase();
    if (
      key === inventoryName ||
      names.has(key) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !checksum(file.sha256) ||
      ![0o644, 0o755].includes(file.mode)
    ) {
      throw new Error("Invalid or duplicate SDK component file");
    }
    names.set(key, file.path);
    expanded += file.bytes;
  }
  if (
    expanded !== descriptor.expandedBytes ||
    value.notices.some((name) => names.get(componentPath(name).toLowerCase()) !== name)
  ) {
    throw new Error("SDK component inventory size or notices mismatch");
  }
  return value;
}

export async function verifyComponent(root, descriptor) {
  componentDescriptor(descriptor);
  const inventoryPath = resolve(root, inventoryName);
  const info = await lstat(inventoryPath);
  if (!info.isFile() || info.size > maxInventoryBytes) {
    throw new Error("Invalid SDK component inventory file");
  }
  const inventory = validateInventory(await readFile(inventoryPath), descriptor);
  const actual = await filesUnder(root);
  const expected = new Set([inventoryName, ...inventory.files.map((file) => file.path)]);
  if (actual.length !== expected.size || actual.some((path) => !expected.has(path))) {
    throw new Error("SDK component contains missing or unexpected files");
  }
  for (const file of inventory.files) {
    const path = resolve(root, file.path);
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.size !== file.bytes ||
      (process.platform !== "win32" && (info.mode & 0o777) !== file.mode) ||
      (await fileDigest(path)) !== file.sha256
    ) {
      throw new Error(`SDK component file checksum, size or mode mismatch: ${file.path}`);
    }
  }
  return inventory;
}

export async function packComponent({ root, archive, executables = [], notices }) {
  root = resolve(root);
  archive = resolve(archive);
  if (archive === root || archive.startsWith(root + sep)) {
    throw new Error("SDK component archive must be outside its source directory");
  }
  const paths = await filesUnder(root);
  const executableSet = new Set(executables);
  if (
    paths.includes(inventoryName) ||
    !paths.length ||
    paths.length > maxFiles ||
    executables.some((name) => !paths.includes(componentPath(name)))
  ) {
    throw new Error("Invalid SDK component source files or executable selection");
  }
  await mkdir(dirname(archive), { recursive: true });
  const staging = await mkdtemp(resolve(dirname(archive), ".component-"));
  const stagedArchive = resolve(staging, "payload.tar.gz");
  try {
    const files = [];
    for (const path of paths) {
      const target = resolve(staging, path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(resolve(root, path), target);
      const mode = executableSet.has(path) ? 0o755 : 0o644;
      await chmod(target, mode);
      files.push({
        path,
        bytes: (await stat(target)).size,
        mode,
        sha256: await fileDigest(target),
      });
    }
    const inventory = Buffer.from(JSON.stringify({ schema: 1, files, notices }) + "\n");
    const descriptor = {
      format: "tar.gz",
      bytes: 1,
      sha256: "0".repeat(64),
      inventorySha256: hash(inventory),
      files: files.length,
      expandedBytes: inventory.length + files.reduce((total, file) => total + file.bytes, 0),
    };
    componentDescriptor(descriptor);
    validateInventory(inventory, descriptor);
    await writeFile(resolve(staging, inventoryName), inventory);
    await create(
      {
        cwd: staging,
        file: stagedArchive,
        gzip: true,
        portable: true,
        mtime: new Date(0),
        strict: true,
        noDirRecurse: true,
        onWriteEntry(entry) {
          entry.stat.mode = executableSet.has(entry.path) ? 0o755 : 0o644;
        },
      },
      [inventoryName, ...paths],
    );
    descriptor.bytes = (await stat(stagedArchive)).size;
    descriptor.sha256 = await fileDigest(stagedArchive);
    componentDescriptor(descriptor);
    // Never replace an existing release artifact, including a concurrent writer.
    await link(stagedArchive, archive);
    return descriptor;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function unpackComponent({ archive, destination, descriptor }) {
  componentDescriptor(descriptor);
  archive = resolve(archive);
  destination = resolve(destination);
  if (
    (await stat(archive)).size !== descriptor.bytes ||
    (await fileDigest(archive)) !== descriptor.sha256
  ) {
    throw new Error("SDK component archive checksum or size mismatch");
  }
  let expanded = 0;
  const names = new Set();
  const paths = [];
  let count = 0;
  let fileBytes = 0;
  let invalid;
  const inspected = new WeakSet();
  const audit = list({
    strict: true,
    maxMetaEntrySize: 65536,
    filter(path, entry) {
      inspected.add(entry);
      try {
        componentPath(path);
        const key = path.toLowerCase();
        if (
          entry.type !== "File" ||
          names.has(key) ||
          ![0o644, 0o755].includes(entry.mode) ||
          !Number.isSafeInteger(entry.size) ||
          entry.size < 0
        ) {
          throw new Error("Invalid SDK component archive entry");
        }
        names.add(key);
        paths.push(path);
        count++;
        fileBytes += entry.size;
        if (count > descriptor.files + 1 || fileBytes > descriptor.expandedBytes) {
          throw new Error("SDK component exceeds declared expansion bounds");
        }
      } catch (error) {
        invalid ??= error;
      }
      return false;
    },
  });
  audit.on("ignoredEntry", (entry) => {
    if (!inspected.has(entry)) {
      invalid ??= new Error("SDK component contains an unsupported archive entry");
    }
  });
  // Audit before extraction. No archive entry can write to the filesystem until
  // every path, type, count and declared byte size has passed validation.
  await pipeline(
    createReadStream(archive),
    createGunzip(),
    new Transform({
      transform(chunk, encoding, callback) {
        expanded += chunk.length;
        const limit = descriptor.expandedBytes + (descriptor.files + 1) * 8192 + 1048576;
        callback(
          expanded > limit ? new Error("SDK component exceeds expansion limit") : null,
          chunk,
        );
      },
    }),
    audit,
  );
  if (invalid) {
    throw invalid;
  }
  validateComponentPaths(paths);
  if (
    count !== descriptor.files + 1 ||
    fileBytes !== descriptor.expandedBytes ||
    !names.has(inventoryName)
  ) {
    throw new Error("SDK component archive inventory or expansion mismatch");
  }
  await mkdir(destination);
  try {
    let writing = Promise.resolve();
    let active;
    const reader = list({
      strict: true,
      noResume: true,
      maxMetaEntrySize: 65536,
      onReadEntry(entry) {
        writing = writing.then(async () => {
          active = entry;
          componentPath(entry.path);
          if (entry.type !== "File" || !names.has(entry.path.toLowerCase())) {
            throw new Error("SDK component changed after archive audit");
          }
          const path = resolve(destination, entry.path);
          await mkdir(dirname(path), { recursive: true });
          // Use regular exclusive writes. The general tar extractor's Windows
          // mmap flags are unsupported by the pinned standalone Bun runtime.
          await pipeline(entry, createWriteStream(path, { flags: "wx", mode: entry.mode }));
          await chmod(path, entry.mode);
          active = null;
        });
        writing.catch((error) => reader.abort(error));
      },
    });
    try {
      await pipeline(createReadStream(archive), createGunzip(), reader);
      await writing;
    } catch (error) {
      active?.destroy(error);
      await writing.catch(() => {});
      throw error;
    }
    return await verifyComponent(destination, descriptor);
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
