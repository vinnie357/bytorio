import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const repository = "https://github.com/ctxshift/bytorio/releases/download";
const maxDownload = 16 * 1024 * 1024;
const maxExpanded = 64 * 1024 * 1024;

export function checkVersion(version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/.test(version)) {
    throw new Error("SDK release must be an exact version, such as 0.1.0-preview.1");
  }
  return version;
}

export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type Manifest = {
  schema: 1;
  version: string;
  cliProtocol: 1;
  asset: string;
  bytes: number;
  sha256: string;
};

type Bundle = {
  schema: 1;
  version: string;
  branding: { starterTitle: string; starterMessage: string };
  assets: Record<string, string>;
};

function parseManifest(bytes: Uint8Array, version: string): Manifest {
  const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (
    value.schema !== 1 ||
    value.cliProtocol !== 1 ||
    value.version !== version ||
    value.asset !== `bytorio-sdk-${version}.json.gz` ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes <= 0 ||
    value.bytes > maxDownload ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  ) {
    throw new Error("Unsupported or invalid SDK release manifest; a newer byt may be required");
  }
  return value;
}

function parseBundle(bytes: Uint8Array, manifest: Manifest): Bundle {
  if (bytes.length !== manifest.bytes || digest(bytes) !== manifest.sha256) {
    throw new Error("SDK download checksum or size mismatch");
  }
  const value = JSON.parse(gunzipSync(bytes, { maxOutputLength: maxExpanded }).toString("utf8"));
  if (
    value.schema !== 1 ||
    value.version !== manifest.version ||
    typeof value.branding?.starterTitle !== "string" ||
    typeof value.branding?.starterMessage !== "string" ||
    !value.assets ||
    typeof value.assets !== "object" ||
    Array.isArray(value.assets)
  ) {
    throw new Error("Invalid SDK bundle");
  }
  for (const [name, contents] of Object.entries(value.assets)) {
    if (
      !/^(?:sdk\/[a-zA-Z0-9_./-]+|LICENSE(?:\.[a-zA-Z0-9]+)?)$/.test(name) ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      typeof contents !== "string"
    ) {
      throw new Error("Invalid SDK asset");
    }
  }
  for (const required of [
    "sdk/contract.json",
    "sdk/templates/main.odin",
    "sdk/templates/main.luau",
  ]) {
    if (typeof value.assets[required] !== "string")
      throw new Error(`Missing SDK asset: ${required}`);
  }
  return value;
}

async function download(url: string, limit: number): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok || !response.body)
    throw new Error(`SDK download failed: HTTP ${response.status} (${url})`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("SDK download exceeds size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

async function readCachedSdk(cacheFile: string, version: string) {
  const entry = JSON.parse(await readFile(cacheFile, "utf8"));
  const manifest = parseManifest(Buffer.from(JSON.stringify(entry.manifest)), version);
  const bundle = parseBundle(Buffer.from(entry.archive, "base64"), manifest);
  return { bundle, manifest };
}

export async function resolveSdk(
  version: string,
  options: {
    offline?: boolean;
    cache?: string;
    releaseRoot?: string;
  } = {},
): Promise<{ bundle: Bundle; manifest: Manifest }> {
  checkVersion(version);
  const cache = resolve(
    options.cache ?? process.env.BYTORIO_CACHE_DIR ?? resolve(homedir(), ".cache/bytorio"),
    "sdk",
    version,
  );
  const root = options.releaseRoot ?? repository;
  const cacheFile = resolve(cache, "entry.json");
  try {
    return await readCachedSdk(cacheFile, version);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Cached SDK ${version} is invalid; remove ${cacheFile} and retry`, {
        cause: error,
      });
    }
  }
  if (options.offline)
    throw Object.assign(
      new Error(`SDK ${version} is not cached; run byt sdk install ${version} online first`),
      { code: "SDK_LEGACY_MISSING" },
    );
  const base = `${root}/sdk-v${version}`;
  const manifest = parseManifest(await download(`${base}/sdk-release.json`, 65536), version);
  console.log(`Downloading SDK ${version} (${manifest.bytes} bytes)`);
  const bytes = await download(`${base}/${manifest.asset}`, manifest.bytes);
  const bundle = parseBundle(bytes, manifest);
  await mkdir(cache, { recursive: true });
  const staging = resolve(cache, `${randomUUID()}.tmp`);
  try {
    await writeFile(staging, JSON.stringify({ manifest, archive: bytes.toString("base64") }), {
      flag: "wx",
    });
    // Publish a complete entry without replacing a concurrent installer's file.
    // Hard links make this atomic on both NTFS and the supported Mac filesystems.
    try {
      await link(staging, cacheFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const winner = await readCachedSdk(cacheFile, version);
      if (winner.manifest.sha256 !== manifest.sha256) {
        throw new Error(`SDK ${version} changed during concurrent installation`);
      }
      return winner;
    }
  } finally {
    await rm(staging, { force: true });
  }
  return { bundle, manifest };
}
