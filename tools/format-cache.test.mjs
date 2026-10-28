import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { formatCacheKey, formatSource } from "./code-tools.mjs";
import { repo, tool } from "./toolchain.mjs";

const source = Array.from(
  { length: 250 },
  (_, index) =>
    `local function entry${index}(value) local result = {first = value, ` +
    'second = value + 1, third = value + 2, description = "a long description ' +
    'that requires wrapping"} return result end',
).join("\n");

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), "format-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = join(root, "cache");
  mkdirSync(cache);
  return { cache, timings: join(root, "timings.jsonl") };
}

function environment(t, { cache, timings }) {
  const previousCache = process.env.BYTORIO_FORMAT_CACHE;
  const previousTimings = process.env.VALIDATION_COMMAND_TIMINGS;
  process.env.BYTORIO_FORMAT_CACHE = cache;
  process.env.VALIDATION_COMMAND_TIMINGS = timings;
  t.after(() => {
    for (const [name, value] of [
      ["BYTORIO_FORMAT_CACHE", previousCache],
      ["VALIDATION_COMMAND_TIMINGS", previousTimings],
    ]) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });
}

function formatterCalls(path, name) {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(({ executable }) => executable.endsWith(name)).length;
  } catch (error) {
    if (error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

const styluaCalls = (path) => formatterCalls(path, "stylua");

function child(script, options = {}) {
  const worker = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repo,
    ...options,
  });
  let stdout = "";
  let stderr = "";
  worker.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  worker.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  return {
    process: worker,
    get stderr() {
      return stderr;
    },
    completed: new Promise((resolve, reject) => {
      worker.once("error", reject);
      worker.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    }),
  };
}

test("concurrent identical inputs share one formatter convergence", async (t) => {
  const baseline = scratch(t);
  environment(t, baseline);
  const expected = formatSource(source, "game.luau");
  const calls = styluaCalls(baseline.timings);
  assert.ok(calls >= 1);

  const shared = scratch(t);
  const script = `
    import { formatSource } from "./tools/code-tools.mjs";
    process.stdout.write(formatSource(${JSON.stringify(source)}, "game.luau"));
  `;
  const children = Array.from({ length: 4 }, () =>
    child(script, {
      env: {
        ...process.env,
        BYTORIO_FORMAT_CACHE: shared.cache,
        VALIDATION_COMMAND_TIMINGS: shared.timings,
      },
    }),
  );
  t.after(async () => {
    for (const { process: worker } of children) {
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill();
      }
    }
    await Promise.all(children.map(({ completed }) => completed));
  });
  const results = await Promise.all(children.map(({ completed }) => completed));
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, expected);
  }
  assert.ok(styluaCalls(shared.timings) <= calls, "concurrent callers must reuse the result");
});

test("a repeated input returns cached text without spawning stylua", (t) => {
  const paths = scratch(t);
  environment(t, paths);
  const expected = formatSource(source, "game.luau");
  assert.ok(styluaCalls(paths.timings) >= 1);
  writeFileSync(paths.timings, "");
  assert.equal(formatSource(source, "game.luau"), expected);
  assert.equal(styluaCalls(paths.timings), 0);
});

test("changed source and filename each require formatting", (t) => {
  const paths = scratch(t);
  environment(t, paths);
  formatSource(source, "a.luau");
  for (const [input, filename] of [
    [source + "\nlocal extra = {value=1}\n", "a.luau"],
    [source, "b.luau"],
  ]) {
    writeFileSync(paths.timings, "");
    formatSource(input, filename);
    assert.ok(styluaCalls(paths.timings) >= 1, `${filename} must have a separate key`);
  }
});

test("a dead owner's cache lock is recovered", { timeout: 10000 }, async (t) => {
  const paths = scratch(t);
  environment(t, paths);
  const owner = child("");
  assert.equal((await owner.completed).code, 0);
  const input = "local value = 1\n";
  const key = formatCacheKey(input, "game.luau");
  assert.match(key, /^[a-f0-9]{64}$/);
  const lock = join(paths.cache, `${key}.lock`);
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), String(owner.process.pid));
  const started = Date.now();
  assert.equal(formatSource(input, "game.luau"), input);
  assert.ok(Date.now() - started < 5000, "dead owners must not block formatting");
  assert.equal(readdirSync(paths.cache).includes(`${key}.lock`), false);
});

test("a live owner's lock is waited for, not taken over", { timeout: 10000 }, async (t) => {
  const paths = scratch(t);
  environment(t, paths);
  const owner = child('process.stdin.resume(); process.stderr.write("started\\n");');
  const workers = [owner];
  t.after(async () => {
    for (const { process: worker } of workers) {
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill();
      }
    }
    await Promise.all(workers.map(({ completed }) => completed));
  });
  const ownerDeadline = Date.now() + 2000;
  while (!owner.stderr.includes("started\n") && Date.now() < ownerDeadline) {
    await setImmediate();
  }
  assert.ok(owner.stderr.includes("started\n"), "the lock owner must be alive");
  const input = "local value = 1\n";
  const key = formatCacheKey(input, "game.luau");
  const entry = join(paths.cache, key);
  const lock = `${entry}.lock`;
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), String(owner.process.pid));
  const old = new Date(Date.now() - 10000);
  utimesSync(lock, old, old);
  writeFileSync(paths.timings, "");
  const waiter = child(
    `
      import { formatSource } from "./tools/code-tools.mjs";
      process.stderr.write("started\\n");
      process.stdout.write(formatSource(${JSON.stringify(input)}, "game.luau"));
    `,
    {
      env: {
        ...process.env,
        BYTORIO_FORMAT_CACHE: paths.cache,
        VALIDATION_COMMAND_TIMINGS: paths.timings,
      },
    },
  );
  workers.push(waiter);
  const deadline = Date.now() + 2000;
  while (!waiter.stderr.includes("started\n") && Date.now() < deadline) {
    await setImmediate();
  }
  assert.ok(waiter.stderr.includes("started\n"), "the waiter must start before publication");
  assert.equal(readFileSync(join(lock, "pid"), "utf8"), String(owner.process.pid));
  const sentinel = "-- written by the owner\n";
  const temporary = `${entry}.owner.tmp`;
  writeFileSync(temporary, sentinel);
  renameSync(temporary, entry);
  rmSync(lock, { recursive: true });
  const result = await waiter.completed;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, sentinel);
  assert.equal(styluaCalls(paths.timings), 0);
});

test("a lock without a pid is taken over at once", { timeout: 10000 }, (t) => {
  const paths = scratch(t);
  environment(t, paths);
  const input = "local value = 1\n";
  const key = formatCacheKey(input, "game.luau");
  const lock = join(paths.cache, `${key}.lock`);
  mkdirSync(lock);
  const started = Date.now();
  const result = formatSource(input, "game.luau");
  const elapsed = Date.now() - started;
  assert.equal(result, input);
  assert.ok(elapsed < 2000, `a pidless lock blocked formatting for ${elapsed} ms`);
  assert.equal(existsSync(lock), false);
});

test("C++ sources are not cached", (t) => {
  try {
    tool("clang-format");
  } catch {
    t.skip("clang-format is not installed");
    return;
  }
  const paths = scratch(t);
  environment(t, paths);
  const input = "int main(){return 0;}\n";
  const expected = formatSource(input, "x.cpp");
  assert.ok(formatterCalls(paths.timings, "clang-format") >= 1);
  writeFileSync(paths.timings, "");
  assert.equal(formatSource(input, "x.cpp"), expected);
  assert.ok(formatterCalls(paths.timings, "clang-format") >= 1);
});

test("old entries and stale temp files are pruned when an entry is written", (t) => {
  const paths = scratch(t);
  environment(t, paths);
  const entry = join(paths.cache, "0".repeat(64));
  const stale = join(paths.cache, "junk.tmp");
  const recent = join(paths.cache, "recent.tmp");
  for (const path of [entry, stale, recent]) {
    writeFileSync(path, "old cache data\n");
  }
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(entry, eightDaysAgo, eightDaysAgo);
  utimesSync(stale, twoHoursAgo, twoHoursAgo);
  assert.equal(formatSource("local value = 1\n", "game.luau"), "local value = 1\n");
  assert.equal(existsSync(entry), false, "entries older than seven days must be pruned");
  assert.equal(existsSync(stale), false, "temporary files older than an hour must be pruned");
  assert.equal(existsSync(recent), true, "recent temporary files must be retained");
});

test("a cache hit refreshes the entry's mtime", (t) => {
  const paths = scratch(t);
  environment(t, paths);
  const input = "local value = 1\n";
  const expected = formatSource(input, "game.luau");
  const entry = join(paths.cache, formatCacheKey(input, "game.luau"));
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  utimesSync(entry, old, old);
  writeFileSync(paths.timings, "");
  assert.equal(formatSource(input, "game.luau"), expected);
  assert.equal(styluaCalls(paths.timings), 0);
  assert.ok(statSync(entry).mtimeMs >= Date.now() - 60000, "hits must refresh the entry's mtime");
});

test("formatter failures leave no cached entry", (t) => {
  const paths = scratch(t);
  environment(t, paths);
  assert.throws(() => formatSource("local function broken(\n", "game.luau"));
  assert.ok(styluaCalls(paths.timings) >= 1);
  assert.deepEqual(
    readdirSync(paths.cache).filter((name) => !name.endsWith(".lock")),
    [],
  );
});
