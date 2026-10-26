import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { repo } from "./toolchain.mjs";

// Several `byt` runs started together after a dependency update each find the player stale and rebuild it. The builds
// share one output folder, so they must neither trip over each other's intermediate files (wasm-ld: "cannot open
// runtime.wasm.o") nor let another process read a half-written output: a copy of a truncated dylib fails codesign with
// "main executable failed strict validation".
const web = resolve(repo, "build/odin-player/web");

function build(artifact) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["tools/player-build.mjs", artifact], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (status) => done({ status, output }));
  });
}

test("simultaneous player builds all succeed and no reader ever sees a partial output", async () => {
  const wasm = resolve(web, "game.wasm");
  const first = await build("hello");
  assert.equal(first.status, 0, `the first build: ${first.output.slice(-800)}`);
  const complete = (await stat(wasm)).size;
  const problems = [];
  let building = true;
  const reader = (async () => {
    while (building) {
      try {
        const bytes = await readFile(wasm);
        if (bytes.length !== complete || !WebAssembly.validate(bytes)) {
          problems.push(`read ${bytes.length} of ${complete} bytes`);
        }
      } catch (error) {
        problems.push(error.code);
      }
    }
  })();
  const results = await Promise.all(Array.from({ length: 4 }, () => build("hello")));
  building = false;
  await reader;
  for (const result of results) {
    assert.equal(result.status, 0, result.output.slice(-600));
  }
  assert.deepEqual([...new Set(problems)], [], "a reader saw a missing or partial game.wasm");
  const left = (await readdir(web)).filter((name) => name.startsWith(".tmp-"));
  assert.deepEqual(left, [], "intermediate files were left behind");
});
