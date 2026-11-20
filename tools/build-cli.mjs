import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { branding } from "./branding.mjs";
import { repo, run } from "./toolchain.mjs";
import { compileCli } from "./compile-cli.mjs";
import { cliVersion } from "./release-config.mjs";
import { requireCliHost } from "./host-platform.mjs";
import { dependencyNotices } from "./dependency-notices.mjs";

const host = requireCliHost();

const output = resolve(repo, "build/cli");
await mkdir(output, { recursive: true });
const paths = ["sdk/contract.json"];
for (const directory of ["sdk/templates", "sdk/luau"]) {
  for (const entry of await readdir(resolve(repo, directory), { withFileTypes: true })) {
    if (entry.isFile() && /\.(json|luau|odin)$/.test(entry.name)) {
      paths.push(`${directory}/${entry.name}`);
    }
  }
}
const assets = Object.fromEntries(
  await Promise.all(
    paths.sort().map(async (path) => [path, await readFile(resolve(repo, path), "utf8")]),
  ),
);
const version = cliVersion(process.env.BYTORIO_RELEASE_TAG);
await writeFile(
  resolve(output, "assets.ts"),
  `export const assets: Record<string, string> = ${JSON.stringify(assets)};\n` +
    `export const branding = ${JSON.stringify(branding)};\n` +
    `export const version = ${JSON.stringify(version)};\n` +
    `export const notices = ${JSON.stringify(await dependencyNotices())};\n`,
);
run(process.execPath, [
  resolve(repo, "node_modules/typescript/bin/tsc"),
  "-p",
  "tools/cli/tsconfig.json",
]);
const executable = resolve(output, host.executable);
compileCli(["tools/cli/main.ts"], executable);
const bytes = await readFile(executable);
await writeFile(
  resolve(output, "release.json"),
  JSON.stringify(
    {
      version,
      platform: host.id,
      status: "standalone-authoring-preview",
      executable: host.executable,
      asset: host.cliAsset,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sdkAssets: paths.sort(),
    },
    null,
    2,
  ) + "\n",
);
console.log(`Built standalone CLI preview: build/cli/${host.executable} (${bytes.length} bytes)`);
