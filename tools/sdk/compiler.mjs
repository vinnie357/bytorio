import { cp, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";

// Keep the pinned compiler's relative library layout, including its Mac LLVM
// dylib. The producer supplies the target-specific linker separately.
const supportDirectories = new Set(["base", "core", "shared", "vendor", "libs"]);

export async function copyOdinDistribution(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isFile() || supportDirectories.has(entry.name)) {
      await cp(resolve(source, entry.name), resolve(target, entry.name), { recursive: true });
    }
  }
}
