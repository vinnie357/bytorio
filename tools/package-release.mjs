import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { releaseConfig } from "./release-config.mjs";
import { repo } from "./toolchain.mjs";
import { requireCliHost } from "./host-platform.mjs";
import { createCliArchive } from "./cli-release-archive.mjs";
import { dependencyNotices } from "./dependency-notices.mjs";

const release = releaseConfig(process.env.BYTORIO_RELEASE_TAG);
const output = resolve(repo, "build/releases", release.tag);
await mkdir(output, { recursive: true });
let source;
let files;
if (release.kind === "byt") {
  // Publish the exact binary already exercised by test:cli, not a later rebuild.
  source = resolve(repo, "build/cli");
  const host = requireCliHost();
  files = [
    [host.executable, host.cliAsset],
    ["release.json", host.cliManifest],
  ];
} else {
  throw new Error(
    "SDK releases must be assembled from host candidates and qualified before publication",
  );
}
for (const [sourceName, targetName = sourceName] of files) {
  await copyFile(resolve(source, sourceName), resolve(output, targetName));
}
if (release.kind === "byt") {
  const host = requireCliHost();
  const manifest = JSON.parse(await readFile(resolve(output, host.cliManifest), "utf8"));
  const packaged = await createCliArchive(
    release,
    manifest,
    resolve(output, host.cliAsset),
    output,
  );
  await writeFile(resolve(output, host.cliManifest), JSON.stringify(packaged, null, 2) + "\n");
}
const notes =
  release.kind === "byt"
    ? "Standalone game authoring for Windows x64 and macOS. Run `byt new my-game`, then `byt run my-game` or `byt dev my-game`. The CLI selects an exact compatible SDK and downloads verified tools and players when first needed. No Bytorio checkout, Node, Bun or global compiler is required. Luau/browser authoring supports Windows, Apple Silicon and Intel Macs; Odin and native players support Windows and Apple Silicon. Build defaults to web; native requires `--target native`. Mac binaries are ad hoc signed. Platform archives retain the short pinned mise format and older mise compatibility. `byt --licenses` prints bundled JavaScript dependency notices."
    : "";
await writeFile(
  resolve(output, "release-notes.md"),
  `${notes}\n\n` +
    "This preview supports the SDK's embeddable runtime, production web player and configurable touch controls. Web/native target changes and cartridge packing preserve existing exports for other targets and print their refresh commands. Cartridge output protection resolves filesystem aliases before checking managed exports. Existing games keep their SDK pin until `byt sdk upgrade` is run explicitly.\n\n" +
    "[Getting started](https://bytor.io/docs/docs/getting-started.html) explains installation and game authoring.\n\n" +
    `Source: tag \`${release.tag}\`. Windows and Apple Silicon run the full validation suite; Intel Mac runs the standalone CLI suite.\n`,
);
await writeFile(resolve(output, "THIRD-PARTY-NOTICES.txt"), await dependencyNotices());
console.log(`Packaged ${release.tag}`);
