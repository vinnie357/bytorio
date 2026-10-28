import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { repo, run } from "./toolchain.mjs";

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

function pids(args) {
  const result = spawnSync("pgrep", args, { encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  return result.stdout
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((pid) => pid !== result.pid);
}

// Children of this process, zombies included: pgrep skips zombies, and an unreaped watchdog is one.
function children() {
  const result = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  assert.equal(result.error, undefined);
  return result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, parent]) => parent === process.pid && pid !== result.pid)
    .map(([pid]) => pid);
}

function watchdogs(pid = process.pid) {
  return pids(["-f", `bytorio-watchdog-${pid}`]);
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
  if (process.platform === "darwin") {
    assert.match(failure.message, /Call graph:[^\n]*\n(?:[ \t]*\n)*[ \t]+\S[^\n]*/);
  }
  assert.equal(
    failure.message.trimEnd().split("\n").at(-1),
    `stuck: ${evidence[0].trim()} | report: ${report}`,
  );
});

test("a synchronous loop of commands leaves no child processes", posix, (t) => {
  scratch(t);
  for (let index = 0; index < 30; index++) {
    assert.equal(run(process.execPath, ["-e", ""], { timeout: 3000 }), "");
  }
  const left = children();
  const remaining = watchdogs();
  assert.deepEqual(left, [], "synchronous calls must leave no children to reap");
  assert.deepEqual(remaining, [], "synchronous calls must stop their watchdogs");
});

test("a command that throws before running stops its watchdog", posix, async (t) => {
  scratch(t);
  const previous = new Set(pids(["-P", String(process.pid)]));
  t.after(() => {
    const remaining = new Set([
      ...watchdogs(),
      ...pids(["-P", String(process.pid)]).filter((pid) => !previous.has(pid)),
    ]);
    for (const pid of remaining) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") {
          throw error;
        }
      }
    }
  });
  assert.throws(() => run(process.execPath, ["-e", "", "a\u0000b"], { timeout: 3000 }), {
    code: "ERR_INVALID_ARG_VALUE",
  });
  const children = pids(["-P", String(process.pid)]).filter((pid) => !previous.has(pid));
  const deadline = Date.now() + 2000;
  let remaining;
  do {
    remaining = watchdogs();
    if (remaining.length === 0) {
      break;
    }
    await setImmediate();
  } while (Date.now() < deadline);
  assert.deepEqual(remaining, [], "argument validation failures must stop the watchdog");
  assert.deepEqual(children, [], "argument validation failures must leave no watchdog children");
});

test("a running command has a marked watchdog that stops on completion", posix, async (t) => {
  scratch(t);
  const worker = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { run } from "./tools/toolchain.mjs";
        run(process.execPath, ["-e", "setTimeout(() => {}, 1500)"], { timeout: 30000 });
      `,
    ],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  worker.stdout.resume();
  worker.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const completed = new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("close", (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    if (worker.exitCode === null && worker.signalCode === null) {
      worker.kill();
    }
    await completed;
  });
  const deadline = Date.now() + 2000;
  let marked;
  do {
    marked = watchdogs(worker.pid);
    if (marked.length > 0 || worker.exitCode !== null || worker.signalCode !== null) {
      break;
    }
    await setImmediate();
  } while (Date.now() < deadline);
  const result = await completed;
  const remaining = watchdogs(worker.pid);
  assert.ok(marked.length > 0, "a running command must expose its watchdog marker");
  assert.equal(result.code, 0, stderr);
  assert.equal(result.signal, null);
  assert.deepEqual(remaining, [], "the marked watchdog must stop before run returns");
});

test("successful commands leave no reports or watchdogs", posix, (t) => {
  const { reports } = scratch(t);
  assert.equal(run(process.execPath, ["-e", ""], { timeout: 3000 }), "");
  assert.deepEqual(watchdogs(), [], "successful commands must stop their watchdogs synchronously");
  assert.deepEqual(reportFiles(reports), []);
});
