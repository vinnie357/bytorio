import { checkVersion } from "./cli/sdk-bundle.ts";
import { createHash } from "node:crypto";
import { cliPlatforms, hostPlatform } from "./host-platform.mjs";

const developmentCliVersion = "0.2.0-preview.2";
export const sdkCliVersionRange = ">=0.2.0-preview.2 <0.3.0";

export function cliReleasePlatform(id) {
  if (!cliPlatforms.includes(id)) {
    throw new Error(`Unsupported CLI release platform: ${id}`);
  }
  const [platform, arch] = id.split("-");
  return hostPlatform(platform === "windows" ? "win32" : "darwin", arch);
}

export function releaseConfig(tag) {
  const match = /^(byt|sdk)-v(.+)$/.exec(tag ?? "");
  if (!match) {
    throw new Error("Expected a byt-v<version> or sdk-v<version> release tag");
  }
  const version = checkVersion(match[2]);
  const kind = match[1];
  return { tag, kind, version, prerelease: version.includes("-") };
}

export function cliVersion(tag) {
  if (!tag) {
    return developmentCliVersion;
  }
  const release = releaseConfig(tag);
  return release.kind === "byt" ? release.version : developmentCliVersion;
}

export function verifyReleaseAsset(release, manifest, bytes, platform = manifest.platform) {
  const host = release.kind === "byt" ? cliReleasePlatform(platform) : undefined;
  const filename = host ? host.executable : `bytorio-sdk-${release.version}.json.gz`;
  if (
    manifest.version !== release.version ||
    manifest.bytes !== bytes.length ||
    manifest.sha256 !== createHash("sha256").update(bytes).digest("hex") ||
    (host && (manifest.platform !== host.id || manifest.asset !== host.cliAsset)) ||
    (release.kind === "byt" ? manifest.executable !== filename : manifest.asset !== filename)
  ) {
    throw new Error("Release version, size, filename or checksum does not match its asset");
  }
}

export function verifyReleaseArchive(release, manifest, bytes, platform = manifest.platform) {
  const host = cliReleasePlatform(platform);
  const archive = manifest.archive;
  if (
    release.kind !== "byt" ||
    manifest.version !== release.version ||
    manifest.platform !== host.id ||
    archive?.asset !== host.cliArchive ||
    archive.bytes !== bytes.length ||
    archive.sha256 !== createHash("sha256").update(bytes).digest("hex")
  ) {
    throw new Error("Release archive filename, version, platform, size or checksum does not match");
  }
}
