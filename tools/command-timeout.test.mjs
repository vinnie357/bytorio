import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { run } from "./toolchain.mjs";

const posix = { skip: process.platform === "win32" };

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), "command-timeout-"));
  const reports = join(root, "reports");
  const timings = join(root, "timings.jsonl");
  const previousReports = process.env.BYTORIO_COMMAND_TIMEOUT_REPORTS;
  const previousTimings = process.env.VALIDATION_COMMAND_TIMINGS;
  process.env.BYTORIO_COMMAND_TIMEOUT_REPORTS = reports;
  process.env.VALIDATION_COMMAND_TIMINGS = timings;
  t.after(() => {
    for (const [name, value] of [
      ["BYTORIO_COMMAND_TIMEOUT_REPORTS", previousReports],
      ["VALIDATION_COMMAND_TIMINGS", previousTimings],
    ]) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { reports, timings };
}

function reportFiles(folder) {
  try {
    return readdirSync(folder);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

test("timeouts retain process evidence without retrying", posix, (t) => {
  const { reports, timings } = scratch(t);
  const script = "setTimeout(() => {}, 60000)";
  const started = Date.now();
  let failure;
  try {
    run(process.execPath, ["-e", script], { timeout: 3000 });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error, "the stalled command must throw");
  const commands = readFileSync(timings, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter(({ executable, args }) => executable === process.execPath && args[1] === script);
  assert.equal(commands.length, 1, "a timeout must not retry the command");
  assert.match(failure.message, /spawnSync .* ETIMEDOUT/);
  assert.match(failure.message, /setTimeout/);
  assert.match(failure.message, /\b\d+(?:\.\d+)?\s*ms\b/);
  assert.ok(Date.now() - started >= 2500);
  // ps fields include PID, state, elapsed time, CPU time and RSS before the command.
  const psLine = /^\s*(\d+)\s+[A-Za-z][A-Za-z+<Ns-]*\s+[\d:-]+\s+[\d:.]+\s+\d+\s+.*setTimeout.*$/m;
  const evidence = failure.message.match(psLine);
  assert.ok(evidence, failure.message);
  const files = reportFiles(reports).filter((name) => name.endsWith(".txt"));
  assert.equal(files.length, 1);
  const report = join(reports, files[0]);
  assert.ok(failure.message.includes(report), "the error must name its retained report");
  const contents = readFileSync(report, "utf8");
  assert.match(contents, psLine);
  assert.ok(contents.includes(evidence[1]), "the report must identify the stalled child");
});

test("successful commands leave no reports or watchdogs", posix, async (t) => {
  const { reports } = scratch(t);
  assert.equal(run(process.execPath, ["-e", ""], { timeout: 3000 }), "");
  const deadline = Date.now() + 2000;
  let children;
  do {
    children = spawnSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" });
    assert.equal(children.error, undefined);
    assert.ok(children.status === 0 || children.status === 1, children.stderr);
    if (children.status === 1) {
      break;
    }
    await setImmediate();
  } while (Date.now() < deadline);
  assert.equal(children.stdout.trim(), "", "watchdog children must be reaped");
  assert.deepEqual(reportFiles(reports), []);
});
