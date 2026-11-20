import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cliReleasePlatform, releaseConfig, verifyReleaseAsset } from "./release-config.mjs";
import { repo, run } from "./toolchain.mjs";
import { cliPlatforms } from "./host-platform.mjs";
import { verifyCliArchive } from "./cli-release-archive.mjs";
import { verifySdkRelease } from "./sdk/release.mjs";

const release = releaseConfig(process.env.BYTORIO_RELEASE_TAG);
const directory = resolve(repo, "build/releases", release.tag);
const check = process.argv.includes("--check");
const platformIndex = process.argv.indexOf("--platform");
if (platformIndex !== -1 && !check) {
  throw new Error("--platform is only valid with --check; publishing requires every platform");
}
const platforms = platformIndex === -1 ? cliPlatforms : [process.argv[platformIndex + 1]];
const files = [];
if (release.kind === "byt") {
  files.push(resolve(directory, "THIRD-PARTY-NOTICES.txt"));
}
const assets =
  release.kind === "byt"
    ? platforms.map((id) => {
        const host = cliReleasePlatform(id);
        return { manifest: host.cliManifest, asset: host.cliAsset, platform: id };
      })
    : [];
if (release.kind === "sdk") {
  const manifest = await verifySdkRelease(directory, release.version);
  files.push(
    resolve(directory, "sdk-release.json"),
    ...Object.values(manifest.components).map(({ asset }) => resolve(directory, asset)),
  );
}
for (const entry of assets) {
  const manifest = JSON.parse(await readFile(resolve(directory, entry.manifest), "utf8"));
  const bytes = await readFile(resolve(directory, entry.asset));
  verifyReleaseAsset(release, manifest, bytes, entry.platform);
  files.push(resolve(directory, entry.manifest), resolve(directory, entry.asset));
  if (release.kind === "byt") {
    const archive = resolve(directory, cliReleasePlatform(entry.platform).cliArchive);
    await verifyCliArchive(release, manifest, archive);
    files.push(archive);
  }
}
if (check) {
  console.log(`Verified release assets for ${release.tag}`);
} else {
  // gh creates a draft, uploads every asset, then publishes. An existing release
  // fails rather than replacing files clients may already have pinned.
  const args = [
    "release",
    "create",
    release.tag,
    "--verify-tag",
    "--title",
    `Bytorio ${release.kind === "byt" ? "CLI" : "SDK"} ${release.version}`,
    "--notes-file",
    resolve(directory, "release-notes.md"),
    ...files,
  ];
  if (release.prerelease) {
    args.push("--prerelease");
  }
  console.log(run("gh", args, { timeout: 600000 }));
}
