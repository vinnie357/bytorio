import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sdkCacheRoot } from "./component-cache.mjs";
import {
  maxManifestBytes,
  orderedSdkVersions,
  parseSdkManifest,
  sdkCompatibility,
  sdkReleaseVersion,
} from "./sdk-manifest.mjs";

const releaseRoot = "https://github.com/ctxshift/bytorio/releases/download";
const catalogueRoot = "https://api.github.com/repos/ctxshift/bytorio/releases";
const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digestPattern = /^[a-f0-9]{64}$/;

function releaseDirectory(version, options) {
  sdkReleaseVersion(version);
  return resolve(options.cache ?? sdkCacheRoot(), "sdk/releases", version);
}

async function metadataRequest(url, limit, options) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers = { "User-Agent": "byt", Accept: "application/json" };
  if (new URL(url).origin === "https://api.github.com" && token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(url, {
    signal: AbortSignal.timeout(options.timeoutMs ?? 60000),
    headers,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`SDK metadata request failed: HTTP ${response.status}`);
  }
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.length;
      if (size > limit) {
        throw new Error("SDK metadata exceeds download size limit");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

function decodedRelease(bytes, version, expectedSha256) {
  let manifest;
  try {
    manifest = parseSdkManifest(bytes, version);
  } catch (error) {
    try {
      const legacy = JSON.parse(Buffer.from(bytes).toString("utf8"));
      if (legacy.schema === 1 && legacy.cliProtocol === 1) {
        error.code = "SDK_LEGACY_PROTOCOL";
      }
    } catch {
      // Preserve the bounded manifest parser's original diagnostic.
    }
    throw error;
  }
  const sha256 = checksum(bytes);
  if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
    throw new Error(`SDK ${version} metadata checksum differs from its exact dependency pin`);
  }
  return { manifest, sha256, metadata: bytes, prerelease: version.includes("-") };
}

async function cachedRelease(version, options) {
  const file = resolve(releaseDirectory(version, options), "entry.json");
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (!info.isFile() || info.size > maxManifestBytes * 2) {
    throw new Error("Invalid SDK metadata cache record");
  }
  const entry = JSON.parse(await readFile(file, "utf8"));
  if (
    entry.schema !== 2 ||
    entry.version !== version ||
    typeof entry.metadata !== "string" ||
    typeof entry.prerelease !== "boolean" ||
    typeof entry.sha256 !== "string" ||
    !digestPattern.test(entry.sha256)
  ) {
    throw new Error("Invalid SDK metadata cache identity");
  }
  const bytes = Buffer.from(entry.metadata, "base64");
  if (bytes.toString("base64") !== entry.metadata || checksum(bytes) !== entry.sha256) {
    throw new Error("SDK metadata cache checksum mismatch");
  }
  const release = decodedRelease(bytes, version, options.expectedSha256);
  return { ...release, prerelease: entry.prerelease || release.prerelease };
}

async function publishRelease(release, options) {
  const { manifest, sha256, metadata } = release;
  const directory = releaseDirectory(manifest.version, options);
  await mkdir(directory, { recursive: true });
  const staging = resolve(directory, `${randomUUID()}.tmp`);
  const file = resolve(directory, "entry.json");
  try {
    await writeFile(
      staging,
      JSON.stringify({
        schema: 2,
        version: manifest.version,
        sha256,
        metadata: metadata.toString("base64"),
        prerelease: release.prerelease,
      }) + "\n",
      { flag: "wx" },
    );
    try {
      await link(staging, file);
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      let winner;
      try {
        winner = await cachedRelease(manifest.version, { ...options, expectedSha256: undefined });
      } catch {
        // Atomically repair an invalid cache record using freshly verified metadata.
      }
      if (winner) {
        if (winner.sha256 !== sha256) {
          throw new Error(`Immutable SDK ${manifest.version} release metadata changed`, {
            cause: error,
          });
        }
        return winner;
      }
      await rename(staging, file);
    }
  } finally {
    await rm(staging, { force: true });
  }
  return release;
}

async function remoteRelease(version, options) {
  const root = (options.releaseRoot ?? releaseRoot).replace(/\/$/, "");
  const bytes = await metadataRequest(
    `${root}/sdk-v${version}/sdk-release.json`,
    maxManifestBytes,
    options,
  );
  return decodedRelease(bytes, version, options.expectedSha256);
}

export async function resolveSdkRelease(version, options = {}) {
  sdkReleaseVersion(version);
  if (
    options.expectedSha256 !== undefined &&
    (typeof options.expectedSha256 !== "string" || !digestPattern.test(options.expectedSha256))
  ) {
    throw new Error("Invalid SDK metadata dependency checksum");
  }
  let corruption;
  try {
    const cached = await cachedRelease(version, options);
    if (cached) {
      return cached;
    }
  } catch (error) {
    corruption = error;
  }
  if (options.offline) {
    throw new Error(
      corruption
        ? `SDK ${version} metadata is corrupt or differs from its pin; retry online to verify it`
        : `SDK ${version} is not installed; run byt sdk install ${version} online first`,
      { cause: corruption },
    );
  }
  options.onProgress?.({ phase: "metadata", version });
  return publishRelease(await remoteRelease(version, options), options);
}

async function installedVersions(options) {
  try {
    const entries = await readdir(resolve(options.cache ?? sdkCacheRoot(), "sdk/releases"), {
      withFileTypes: true,
    });
    return orderedSdkVersions(
      entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      options,
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function availableVersions(options) {
  const versions = new Map();
  for (let page = 1; page <= 20; page++) {
    const url = new URL(options.catalogueRoot ?? catalogueRoot);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const releases = JSON.parse(
      (await metadataRequest(url, 2 * 1024 * 1024, options)).toString("utf8"),
    );
    if (!Array.isArray(releases) || releases.length > 100) {
      throw new Error("Invalid SDK release catalogue");
    }
    for (const release of releases) {
      if (
        release?.draft === false &&
        (options.allowPrerelease || release.prerelease === false) &&
        typeof release.tag_name === "string" &&
        release.tag_name.startsWith("sdk-v")
      ) {
        const version = release.tag_name.slice(5);
        versions.set(version, Boolean(release.prerelease) || versions.get(version) === true);
      }
    }
    if (releases.length < 100) {
      return orderedSdkVersions([...versions.keys()], options).map((version) => ({
        version,
        prerelease: versions.get(version) || version.includes("-"),
      }));
    }
  }
  throw new Error("SDK release catalogue exceeds page limit; select an exact SDK with --sdk");
}

export async function selectSdkRelease(requirements, options) {
  // Preview eligibility belongs to the command's chosen policy, not a hidden resolver default.
  orderedSdkVersions([], options);
  for (const version of options.preferInstalled === false ? [] : await installedVersions(options)) {
    try {
      const installed = await cachedRelease(version, options);
      if (
        installed &&
        (options.allowPrerelease || !installed.prerelease) &&
        sdkCompatibility(installed.manifest, requirements) === null
      ) {
        return installed;
      }
    } catch (error) {
      options.onProgress?.({ phase: "skip-installed", version, reason: error.message });
    }
  }
  if (options.offline) {
    throw new Error(
      `No compatible installed SDK for ${requirements.language} on ${requirements.host}; run online once or select --sdk`,
    );
  }
  options.onProgress?.({ phase: "discover" });
  for (const { version, prerelease } of await availableVersions(options)) {
    let release;
    try {
      release = await remoteRelease(version, options);
      release.prerelease = prerelease;
    } catch (error) {
      if (!/Invalid SDK manifest|Invalid SDK component|HTTP 404/.test(error.message)) {
        throw error;
      }
      options.onProgress?.({ phase: "skip-release", version, reason: error.message });
      continue;
    }
    const reason = sdkCompatibility(release.manifest, requirements);
    if (reason === null) {
      return publishRelease(release, options);
    }
    options.onProgress?.({ phase: "skip-release", version, reason });
  }
  throw new Error(
    `No compatible standalone SDK release for ${requirements.language} on ${requirements.host} (${requirements.target})`,
  );
}
