import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { timedSpawnSync } from "./command-timing.mjs";
import { nativeLinkerFlags, repo, tool } from "./toolchain.mjs";
import { sourceState } from "./validation-runner.mjs";

// Share successful unit checks only inside the current validation invocation.
// Standalone verifiers always execute; a new run gets a fresh receipt directory.
export function odinUnitTests(
  suite,
  output,
  {
    compiler = tool("odin"),
    cwd = repo,
    scope = process.env.VALIDATION_UNIT_TESTS,
    fingerprint = scope ? sourceState(cwd).fingerprint : undefined,
    execute = timedSpawnSync,
  } = {},
) {
  const flags = ["-o:none", ...nativeLinkerFlags({ harness: true })];
  const key = createHash("sha256")
    .update(JSON.stringify({ compiler, cwd, suite, flags, fingerprint }))
    .digest("hex");
  const receipt = scope && resolve(scope, `${key}.json`);
  if (receipt && existsSync(receipt)) {
    const previous = JSON.parse(readFileSync(receipt, "utf8"));
    assert.equal(previous.exitCode, 0, "Only successful unit checks may be shared");
    console.log(`Unit check already passed in this validation: ${suite}; ${receipt}`);
    return previous.output;
  }
  const executable = scope ? resolve(scope, `${key}.exe`) : output;
  mkdirSync(dirname(executable), { recursive: true });
  const result = execute(compiler, ["test", suite, ...flags, `-out:${executable}`], {
    cwd,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      SDL_VIDEODRIVER: "dummy",
      SDL_AUDIODRIVER: "dummy",
      SDL_RENDER_DRIVER: "software",
    },
  });
  const text = (result.stdout || "") + (result.stderr || "");
  writeFileSync(`${executable}.log`, text);
  assert.ifError(result.error);
  assert.equal(result.status, 0, text);
  if (receipt) {
    writeFileSync(receipt, JSON.stringify({ suite, fingerprint, exitCode: 0, output: text }));
  }
  return text;
}
