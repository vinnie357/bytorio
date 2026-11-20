import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { link, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { componentDescriptor, unpackComponent, verifyComponent } from "../sdk/component.mjs";

const instancePattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function sdkCacheRoot() {
  if (process.env.BYTORIO_CACHE_DIR) {
    return resolve(process.env.BYTORIO_CACHE_DIR);
  }
  if (process.platform === "win32") {
    return resolve(
      process.env.LOCALAPPDATA || resolve(homedir(), "AppData/Local"),
      "Bytorio/Cache",
    );
  }
  return process.platform === "darwin"
    ? resolve(homedir(), "Library/Caches/Bytorio")
    : resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "bytorio");
}

async function cachedComponent(parent, descriptor) {
  const pointer = resolve(parent, "current.json");
  let info;
  try {
    info = await lstat(pointer);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (!info.isFile() || info.size > 1024) {
    throw new Error("Invalid SDK component cache record");
  }
  const record = JSON.parse(await readFile(pointer, "utf8"));
  if (
    record.schema !== 1 ||
    record.sha256 !== descriptor.sha256 ||
    typeof record.directory !== "string" ||
    !instancePattern.test(record.directory)
  ) {
    throw new Error("Invalid SDK component cache identity");
  }
  const directory = resolve(parent, record.directory);
  return { directory, inventory: await verifyComponent(directory, descriptor) };
}

async function downloadComponent(url, path, descriptor, { timeoutMs = 60000, onProgress }, id) {
  const address = new URL(url);
  if (!["https:", "http:"].includes(address.protocol) || address.username || address.password) {
    throw new Error("SDK component downloads require an HTTP(S) URL without credentials");
  }
  const response = await fetch(address, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`SDK component download failed: HTTP ${response.status}`);
  }
  let transferred = 0;
  await pipeline(
    Readable.fromWeb(response.body),
    new Transform({
      transform(chunk, encoding, callback) {
        transferred += chunk.length;
        if (transferred > descriptor.bytes) {
          callback(new Error("SDK component download exceeds declared size"));
          return;
        }
        try {
          onProgress?.({ id, phase: "download", transferred, total: descriptor.bytes });
          callback(null, chunk);
        } catch (error) {
          callback(error);
        }
      },
    }),
    createWriteStream(path, { flags: "wx" }),
  );
  if (transferred !== descriptor.bytes) {
    throw new Error("SDK component download size mismatch");
  }
}

async function publishComponent(pointer, parent, descriptor) {
  const target = resolve(parent, "current.json");
  try {
    // Cold installs race to create the record, without replacing another writer.
    await link(pointer, target);
    return null;
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const winner = await cachedComponent(parent, descriptor);
      if (winner) {
        return winner;
      }
    } catch {
      // Only an invalid record needs replacement. Recheck after any file lock.
    }
    try {
      await rename(pointer, target);
      return null;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        attempt >= 5 ||
        !["EPERM", "EACCES", "EBUSY"].includes(error.code)
      ) {
        throw error;
      }
      await delay(10 * (attempt + 1));
    }
  }
}

export async function resolveComponent({ id, url, descriptor }, options = {}) {
  componentDescriptor(descriptor);
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    throw new Error("Invalid SDK component identifier");
  }
  const parent = resolve(options.cache ?? sdkCacheRoot(), "sdk/components", descriptor.sha256);
  let corruption;
  try {
    const cached = await cachedComponent(parent, descriptor);
    if (cached) {
      return cached;
    }
  } catch (error) {
    corruption = error;
  }
  if (options.offline) {
    throw new Error(
      corruption
        ? `SDK component ${id} is corrupt in the offline cache; retry this command online to repair it`
        : `SDK component ${id} is not cached; run this command online once to download it`,
      { cause: corruption },
    );
  }
  options.onProgress?.({ id, phase: corruption ? "repair" : "start", total: descriptor.bytes });
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(resolve(parent, ".install-"));
  let installed;
  let published = false;
  try {
    const archive = resolve(staging, "component.tar.gz");
    await downloadComponent(url, archive, descriptor, options, id);
    const payload = resolve(staging, "payload");
    const inventory = await unpackComponent({ archive, destination: payload, descriptor });
    try {
      const winner = await cachedComponent(parent, descriptor);
      if (winner) {
        return winner;
      }
    } catch {
      // A corrupt installation is replaced by a new verified instance below.
    }
    const instance = randomUUID();
    installed = resolve(parent, instance);
    await rename(payload, installed);
    const pointer = resolve(staging, "current.json");
    await writeFile(
      pointer,
      JSON.stringify({ schema: 1, sha256: descriptor.sha256, directory: instance }) + "\n",
      { flag: "wx" },
    );
    // Switching this small record is atomic. Existing readers keep their concrete
    // instance path, including during concurrent acquisition or corruption repair.
    const winner = await publishComponent(pointer, parent, descriptor);
    if (winner) {
      return winner;
    }
    published = true;
    options.onProgress?.({ id, phase: "ready", total: descriptor.bytes });
    return { directory: installed, inventory };
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (installed && !published) {
      await rm(installed, { recursive: true, force: true });
    }
  }
}
