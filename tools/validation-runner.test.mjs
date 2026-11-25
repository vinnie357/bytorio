import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runStep, sourceState, validate } from "./validation-runner.mjs";
import { timedSpawnSync } from "./command-timing.mjs";

function checkedNodeArgs(args) {
  const length = [process.execPath, ...args].join(" ").length;
  assert.ok(length < 32767, `Windows command-line limit is 32,767 characters; received ${length}.`);
  return args;
}

test("command timings retain failed status and original output", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "validation-timing-"));
  const destination = join(cwd, "commands.jsonl");
  const previous = process.env.VALIDATION_COMMAND_TIMINGS;
  try {
    process.env.VALIDATION_COMMAND_TIMINGS = destination;
    const result = timedSpawnSync(
      process.execPath,
      checkedNodeArgs(["-e", "console.log('output'); process.exitCode = 8"]),
      { encoding: "utf8" },
    );
    assert.equal(result.status, 8);
    assert.equal(result.stdout.trim(), "output");
    const event = JSON.parse((await readFile(destination, "utf8")).trim());
    assert.equal(event.exitCode, 8);
    assert.ok(event.durationMs >= 0);
    assert.equal(event.pid, process.pid);
  } finally {
    if (previous === undefined) {
      delete process.env.VALIDATION_COMMAND_TIMINGS;
    } else {
      process.env.VALIDATION_COMMAND_TIMINGS = previous;
    }
  }
});

test("retains large output and preserves a failure after output", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "validation-test-"));
  const log = join(cwd, "output.log");
  const result = await runStep({
    executable: process.execPath,
    args: checkedNodeArgs(["-e", "console.log('x'.repeat(100000)); process.exitCode = 7"]),
    cwd,
    log,
    timeoutMs: 10000,
  });
  assert.equal(result.exitCode, 7);
  assert.ok((await readFile(log)).length > 100000);
});

test("reports launch failure and bounds a hung command", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "validation-test-"));
  const missing = await runStep({
    executable: join(cwd, "missing-executable"),
    args: [],
    cwd,
    log: join(cwd, "missing.log"),
    timeoutMs: 1000,
  });
  assert.equal(missing.exitCode, 127);
  const hung = await runStep({
    executable: process.execPath,
    args: checkedNodeArgs(["-e", "setInterval(() => {}, 1000)"]),
    cwd,
    log: join(cwd, "hung.log"),
    timeoutMs: 100,
  });
  assert.equal(hung.exitCode, 124);
  assert.equal(hung.timedOut, true);
});

test("fingerprints untracked sources but excludes ignored logs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "validation-test-"));
  for (const args of [
    ["init"],
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
  ]) {
    assert.equal(spawnSync("git", args, { cwd }).status, 0);
  }
  await writeFile(join(cwd, ".gitignore"), "*.log\n");
  const initial = sourceState(cwd);
  await writeFile(join(cwd, "output.log"), "ignored");
  assert.equal(sourceState(cwd).fingerprint, initial.fingerprint);
  await writeFile(join(cwd, "example.txt"), "first");
  const added = sourceState(cwd);
  assert.notEqual(added.fingerprint, initial.fingerprint);
  await writeFile(join(cwd, "example.txt"), "second");
  assert.notEqual(sourceState(cwd).fingerprint, added.fingerprint);
});

test("interrupts the active command and removes signal handlers", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "validation-test-"));
  const listeners = process.listenerCount("SIGINT");
  const pending = runStep({
    executable: process.execPath,
    args: checkedNodeArgs(["-e", "setInterval(() => {}, 1000)"]),
    cwd,
    log: join(cwd, "interrupted.log"),
    timeoutMs: 10000,
  });
  process.emit("SIGINT");
  const result = await pending;
  assert.equal(result.exitCode, 130);
  assert.equal(result.interrupted, true);
  assert.equal(process.listenerCount("SIGINT"), listeners);
});

test("stops on failure and rejects results from changing sources", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "validation-test-"));
  for (const args of [
    ["init"],
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
  ]) {
    assert.equal(spawnSync("git", args, { cwd }).status, 0);
  }
  await writeFile(join(cwd, ".gitignore"), "/build/\n");
  const visited = [];
  const options = { cwd, tasks: ["first", "second"], mise: "unused", notify: () => {} };
  const failed = await validate({
    ...options,
    execute: async (step) => {
      visited.push(step.args.at(-1));
      return runStep({
        ...step,
        executable: process.execPath,
        args: checkedNodeArgs(["-e", "process.exit(9)"]),
      });
    },
  });
  assert.equal(failed.status, "failed");
  assert.deepEqual(visited, ["first"]);
  assert.equal(failed.steps[0].exitCode, 9);

  const scopes = [];
  const passing = {
    ...options,
    execute: async (step) => {
      scopes.push(step.env.VALIDATION_UNIT_TESTS);
      await writeFile(
        step.env.VALIDATION_BROWSER_TIMINGS,
        JSON.stringify({ phase: "page.goto", durationMs: 12, error: "expected failure" }) + "\n",
      );
      return { exitCode: 0, durationMs: 0 };
    },
  };
  const timed = await validate(passing);
  assert.equal(timed.status, "passed");
  assert.deepEqual(timed.steps[0].browserSummary, {
    "page.goto": { calls: 1, durationMs: 12, failures: 1 },
  });
  assert.notEqual(timed.steps[0].browser, timed.steps[1].browser);
  assert.equal((await validate(passing)).status, "passed");
  assert.equal(scopes[0], scopes[1]);
  assert.equal(scopes[2], scopes[3]);
  assert.notEqual(scopes[0], scopes[2]);

  const stale = await validate({
    ...options,
    tasks: ["first"],
    execute: async (step) => {
      await writeFile(join(cwd, "changed.txt"), "changed while validating");
      return runStep({
        ...step,
        executable: process.execPath,
        args: checkedNodeArgs(["-e", "console.log('passed')"]),
      });
    },
  });
  assert.equal(stale.status, "stale");
  assert.equal(stale.sourceChanged, true);
  assert.equal(stale.steps[0].exitCode, 0);

  await assert.rejects(validate({ ...options, tasks: ["validate"] }), /non-recursive/);
  for (const task of [
    "//:validate",
    "//examples/kart3d:validate",
    "//../outside:test",
    "//examples/kart3d:test --force",
  ]) {
    await assert.rejects(validate({ ...options, tasks: [task] }), /non-recursive/);
  }
  const nested = await validate({ ...passing, tasks: ["//examples/kart3d:test"] });
  assert.equal(nested.status, "passed");
  assert.equal(nested.steps[0].task, "//examples/kart3d:test");
  assert.match(nested.steps[0].log, /01---examples-kart3d-test\.log$/);
});
