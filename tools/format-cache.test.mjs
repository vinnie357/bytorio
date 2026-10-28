import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatCacheKey, formatSource } from "./code-tools.mjs";
import { repo } from "./toolchain.mjs";

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

function styluaCalls(path) {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(({ executable }) => executable.endsWith("stylua")).length;
  } catch (error) {
    if (error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

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
