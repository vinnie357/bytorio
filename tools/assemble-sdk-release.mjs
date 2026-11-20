import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assembleSdk } from "./sdk/assemble.mjs";

const [canonicalHost, output, ...pairs] = process.argv.slice(2);
if (!canonicalHost || !output || pairs.length < 2 || pairs.length % 2 !== 0) {
  throw new Error(
    "Expected: assemble:sdk-release <canonical host> <output directory> <host> <candidate directory> [...pairs]",
  );
}
const candidates = [];
for (let index = 0; index < pairs.length; index += 2) {
  candidates.push({ host: pairs[index], directory: pairs[index + 1] });
}
await mkdir(dirname(resolve(output)), { recursive: true });
const result = await assembleSdk({ canonicalHost, candidates, output });
console.log(`Assembled SDK ${result.manifest.version}: ${result.output}`);
