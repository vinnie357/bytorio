import assert from "node:assert/strict";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { exportPlayer } from "./player-export.mjs";
import { requireNativeHost } from "./host-platform.mjs";
import { verifyMacLoaderPaths } from "./macos-loader.mjs";
import { copyWasmtimeLibrary, dependencyRoot, repo, run, tool } from "./toolchain.mjs";

const host = requireNativeHost();
const root = resolve(repo, "build/native-platform", randomUUID());
const target = resolve(root, "relocated player with spaces");
await mkdir(root, { recursive: true });
await copyWasmtimeLibrary(root);
const env = {
  ...process.env,
  BYTORIO_NATIVE_TEST_ROOT: root,
  HOME: resolve(root, "home"),
  LOCALAPPDATA: resolve(root, "local-data"),
};
env.BYTORIO_EXPECTED_SAVE_DIRECTORY = host.windows
  ? `${env.LOCALAPPDATA}/Bytorio/saves`
  : `${env.HOME}/Library/Application Support/Bytorio/saves`;
run(
  tool("odin"),
  [
    "test",
    "tests/native-platform",
    "-o:none",
    `-collection:deps=${dependencyRoot()}`,
    `-out:${resolve(root, "filesystem-tests.exe")}`,
  ],
  { env, stdio: "inherit" },
);

await exportPlayer({
  platform: "native",
  source: resolve(repo, "build/odin-player/native"),
  target,
});
await copyFile(resolve(repo, "build/odin-player/native/game.wasm"), resolve(target, "game.wasm"));
await writeFile(resolve(root, "inputs.txt"), "0\n16\n0\n");
const executable = resolve(target, host.player);
const report = JSON.parse(
  run(executable, ["--benchmark", resolve(root, "inputs.txt")], {
    cwd: root,
    env: { ...env, PATH: "" },
  }),
);
assert.ok(report.memory.working > 0, "resident memory probe returns bytes");
assert.ok(report.memory.peakWorking > 0, "peak resident memory probe returns bytes");
if (process.platform === "darwin") {
  for (const name of [host.player, host.sdlLibrary]) {
    const path = resolve(target, name);
    run("codesign", ["--verify", "--strict", path]);
    const loads = run("otool", ["-l", path]);
    verifyMacLoaderPaths(loads, repo);
  }
}
await writeFile(
  resolve(root, "report.json"),
  JSON.stringify(
    {
      status: "passed",
      platform: host.id,
      relocated: true,
      emptyPath: true,
      memory: report.memory,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Native platform passed: ${host.id}, save path, no-replace migration, directory reuse, relocated libraries and memory probes.`,
);
