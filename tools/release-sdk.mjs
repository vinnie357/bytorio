import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { releaseConfig, sdkCliVersionRange } from "./release-config.mjs";
import { hostPlatform } from "./host-platform.mjs";
import { repo, run } from "./toolchain.mjs";
import { assembleSdk } from "./sdk/assemble.mjs";
import { produceHostSdk } from "./sdk/produce.mjs";
import { produceLuauHostSdk } from "./sdk/luau-host.mjs";

const release = releaseConfig(process.env.BYTORIO_RELEASE_TAG);
if (release.kind !== "sdk") {
  throw new Error("Expected an SDK release tag");
}
const candidates = resolve(repo, "build/sdk-candidates");
await mkdir(candidates, { recursive: true });
const action = process.argv[2];
const host = hostPlatform().id;
if (action === "candidate") {
  await produceHostSdk({
    version: release.version,
    cliVersionRange: sdkCliVersionRange,
    output: resolve(candidates, host),
  });
} else if (action === "intel") {
  if (host !== "macos-x64") {
    throw new Error("The source-built analyzer candidate requires Intel Mac");
  }
  const analyzer = resolve(repo, "build/luau-analyzer/bin/luau-analyze");
  run("/usr/bin/codesign", ["--force", "--sign", "-", analyzer]);
  run("/usr/bin/codesign", ["--verify", "--strict", analyzer]);
  await produceLuauHostSdk({
    base: resolve(candidates, "windows-x64"),
    output: resolve(candidates, host),
    host,
    analyzer,
  });
} else if (action === "assemble") {
  const output = resolve(repo, "build/releases", release.tag);
  await mkdir(resolve(repo, "build/releases"), { recursive: true });
  await assembleSdk({
    candidates: ["windows-x64", "macos-arm64", "macos-x64"].map((host) => ({
      host,
      directory: resolve(candidates, host),
    })),
    canonicalHost: "windows-x64",
    output,
  });
  await writeFile(
    resolve(output, "release-notes.md"),
    `SDK ${release.version} provides verified libraries, managed language tools, check workers and matching browser/native players. Requires Bytorio CLI ${sdkCliVersionRange} to create, check, build, pack, run and develop games without a source checkout. Components download lazily into a shared per-user cache; each project's bytorio.lock.toml pins exact metadata and checksums.\n\nThe browser player is an embeddable JavaScript module with a compact production toolbar and configurable D-pad/buttons or tap/drag controls. Use runtime.js directly for a custom player; web exports include a complete custom-player.html example. The diagnostic host remains available separately. Existing games keep their pinned SDK until byt sdk upgrade is run explicitly.\n\nLuau and browser exports support Windows x64, macOS Apple Silicon and Intel. Odin and native players support Windows x64 and Apple Silicon; the pinned Odin compiler does not provide an Intel Mac build.\n\nAll hosts are qualified against this assembled SDK's exact shared bytes with an empty PATH, offline reuse, browser reload after edits and relocated playback after cache removal. Physical iOS/Android browser acceptance remains a separate follow-up; desktop mobile emulation does not establish hardware coverage.\n\n[Getting started](https://bytor.io/docs/docs/getting-started.html) · [Embed the player](https://bytor.io/docs/sdk/web-player.html) · [Build a custom player](https://bytor.io/docs/sdk/web-runtime.html)\n`,
  );
} else {
  throw new Error("Expected release-sdk candidate|intel|assemble");
}
