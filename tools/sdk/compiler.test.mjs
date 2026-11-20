import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { copyOdinDistribution } from "./compiler.mjs";

test("staged Odin retains the LLVM library beside the compiler at its loader-relative path", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "byt-compiler-layout-"));
  try {
    const source = resolve(root, "distribution");
    await mkdir(resolve(source, "libs"), { recursive: true });
    await writeFile(resolve(source, "odin"), "compiler");
    const library = Buffer.from([0, 255, 2, 128, 3]);
    await writeFile(resolve(source, "libs/libLLVM.dylib"), library);
    const target = resolve(root, "SDK component");
    await copyOdinDistribution(source, target);
    assert.equal(await readFile(resolve(target, "odin"), "utf8"), "compiler");
    assert.deepEqual(await readFile(resolve(target, "libs/libLLVM.dylib")), library);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
