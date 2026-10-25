import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { timedSpawnSync as spawnSync } from "./command-timing.mjs";
import { tool, dependencyRoot, nativeLinkerFlags } from "./toolchain.mjs";

// The native mapping runs against an SDL3 virtual gamepad on the dummy video driver.
const out = resolve("build/odin-player/native");
await mkdir(out, { recursive: true });
const unit = spawnSync(
  tool("odin"),
  [
    "test",
    "runtime/odin/native",
    "-o:none",
    "-define:ODIN_TEST_NAMES=main.native_gamepad_mapping",
    `-collection:deps=${dependencyRoot()}`,
    `-out:${resolve(out, "gamepad-tests.exe")}`,
    ...nativeLinkerFlags({ harness: true }),
  ],
  {
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" },
  },
);
await writeFile(resolve(out, "gamepad-tests.log"), (unit.stdout || "") + (unit.stderr || ""));
assert.ifError(unit.error);
assert.equal(unit.status, 0, unit.stdout + unit.stderr);
console.log("native gamepad mapping: PASS");
