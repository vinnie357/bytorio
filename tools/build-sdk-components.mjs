import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { hostPlatform } from "./host-platform.mjs";
import { repo } from "./toolchain.mjs";
import { produceHostSdk } from "./sdk/produce.mjs";
import { sdkReleaseVersion } from "./cli/sdk-manifest.mjs";

const [version, cliVersionRange] = process.argv.slice(2);
if (!version || !cliVersionRange || process.argv.length !== 4) {
  throw new Error("Expected: build:sdk-components <SDK version> <compatible CLI SemVer range>");
}
sdkReleaseVersion(version);
const parent = resolve(repo, "build/sdk-components", version);
await mkdir(parent, { recursive: true });
const result = await produceHostSdk({
  version,
  cliVersionRange,
  output: resolve(parent, hostPlatform().id),
});
console.log(`Host SDK candidate: ${result.output}`);
