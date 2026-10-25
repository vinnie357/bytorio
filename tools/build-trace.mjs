import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { dependencyRoot, nativeLinkerFlags, repo, run, tool } from "./toolchain.mjs";

const kind = process.argv[2];
if (!["resources", "graphics", "audio"].includes(kind)) {
  throw new Error("Specify resources, graphics or audio");
}
const output = resolve(repo, "build/validation-tools", kind);
await mkdir(output, { recursive: true });
run(
  tool("odin"),
  [
    "build",
    `tests/${kind}/player`,
    "-o:speed",
    `-collection:deps=${dependencyRoot()}`,
    `-out:${resolve(output, "trace.exe")}`,
    ...nativeLinkerFlags({ harness: true }),
  ],
  { stdio: "inherit" },
);
