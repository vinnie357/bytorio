import { mkdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { repo, script } from "./toolchain.mjs";

const output = resolve(repo, "build/sdk-candidates");
await mkdir(output, { recursive: true });
for (const host of ["windows-x64", "macos-arm64", "macos-x64"]) {
  await rename(
    resolve(repo, "build/downloaded-candidates", `sdk-candidate-${host}`),
    resolve(output, host),
  );
}
script("tools/release-sdk.mjs", ["assemble"]);
