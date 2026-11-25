import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const module = pathToFileURL(resolve("tools/directory-lock.mjs")).href;

function checkedNodeArgs(args) {
  const length = [process.execPath, ...args].join(" ").length;
  assert.ok(length < 32767, `Windows command-line limit is 32,767 characters; received ${length}.`);
  return args;
}

// The lock releases on process exit, so each case runs in its own process.
function hold(lock, timeoutMs) {
  const script = `import { acquireLock } from ${JSON.stringify(module)};
await acquireLock(${JSON.stringify(lock)}, { timeoutMs: ${timeoutMs} });
console.log("held");`;
  return spawnSync(process.execPath, checkedNodeArgs(["--input-type=module", "-e", script]), {
    encoding: "utf8",
  });
}

test("a lock is released when its process exits", () => {
  const lock = join(mkdtempSync(join(tmpdir(), "directory-lock-")), ".lock");
  assert.match(hold(lock, 1000).stdout, /held/);
  assert.equal(existsSync(lock), false);
  assert.match(hold(lock, 1000).stdout, /held/);
});

test("a lock left by a dead process is taken over", () => {
  const lock = join(mkdtempSync(join(tmpdir(), "directory-lock-")), ".lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), "2147483646");
  assert.match(hold(lock, 5000).stdout, /held/);
});

test("a lock held by a live process times out the waiter", () => {
  const lock = join(mkdtempSync(join(tmpdir(), "directory-lock-")), ".lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), String(process.pid));
  const result = hold(lock, 600);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Timed out/);
});

test("a lock folder with no pid is taken over once it is a few seconds old", () => {
  const lock = join(mkdtempSync(join(tmpdir(), "directory-lock-")), ".lock");
  mkdirSync(lock);
  const old = new Date(Date.now() - 60000);
  utimesSync(lock, old, old);
  assert.match(hold(lock, 3000).stdout, /held/);
});

test("a fresh lock folder with no pid is still respected", () => {
  const lock = join(mkdtempSync(join(tmpdir(), "directory-lock-")), ".lock");
  mkdirSync(lock);
  const result = hold(lock, 600);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Timed out/);
});

// Each waiter claims the critical section with an exclusive file. A second claimant while the first
// still sits inside means two processes held the lock at once.
function waiter(lock, inside, violations) {
  const script = `import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { acquireLock } from ${JSON.stringify(module)};
await acquireLock(${JSON.stringify(lock)}, { timeoutMs: 30000 });
try {
  writeFileSync(${JSON.stringify(inside)}, String(process.pid), { flag: "wx" });
} catch {
  appendFileSync(${JSON.stringify(violations)}, "overlap\\n");
}
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
rmSync(${JSON.stringify(inside)}, { force: true });`;
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, checkedNodeArgs(["--input-type=module", "-e", script]));
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => {
      stderr += text;
    });
    child.on("error", reject);
    child.on("close", (code) => done({ code, stderr }));
  });
}

for (const waiters of [2, 8]) {
  test(`${waiters} waiters taking over one stale lock never overlap`, async () => {
    for (let round = 0; round < 5; round++) {
      const root = mkdtempSync(join(tmpdir(), "directory-lock-"));
      const lock = join(root, ".lock");
      const violations = join(root, "violations");
      // Dead owner in even rounds, abandoned pid-less folder in odd rounds.
      mkdirSync(lock);
      if (round % 2 === 0) {
        writeFileSync(join(lock, "pid"), "2147483646");
      } else {
        const old = new Date(Date.now() - 60000);
        utimesSync(lock, old, old);
      }
      const results = await Promise.all(
        Array.from({ length: waiters }, () => waiter(lock, join(root, "inside"), violations)),
      );
      const diagnostics = results
        .map(({ code, stderr }, index) =>
          code === 0 ? "" : `waiter ${index} exited ${code}:\n${stderr}`,
        )
        .filter(Boolean)
        .join("\n");
      assert.deepEqual(
        results.map(({ code }) => code),
        Array(waiters).fill(0),
        `round ${round}:\n${diagnostics}`,
      );
      assert.equal(existsSync(violations), false, `round ${round}: two holders at once`);
      assert.equal(existsSync(lock), false, "the last holder releases the lock");
    }
  });
}

function injectedMkdir(t, target, codes, assertions, { persistent = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "directory-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lock = join(root, ".lock");
  if (target === "gate") {
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), "2147483646");
  }
  const directory = target === "gate" ? `${lock}.takeover` : lock;
  const script = `import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { acquireLock } from ${JSON.stringify(module)};
const lock = ${JSON.stringify(lock)};
const directory = ${JSON.stringify(directory)};
const failures = ${JSON.stringify(codes)}.map(code => Object.assign(new Error("injected mkdir " + code), { code }));
let calls = 0;
const injectedFs = {
  ...fs,
  async mkdir(path, ...args) {
    if (path === directory) {
      calls++;
      const error = ${persistent ? "failures[0]" : "failures[calls - 1]"};
      if (error) throw error;
    }
    return fs.mkdir(path, ...args);
  },
};
${assertions}`;
  const result = spawnSync(
    process.execPath,
    checkedNodeArgs(["--input-type=module", "-e", script]),
    { encoding: "utf8", timeout: 3000 },
  );
  assert.equal(
    result.status,
    0,
    `${target} mkdir child failed: ${result.error?.message || ""}\n${result.stderr}`,
  );
}

for (const target of ["lock", "gate"]) {
  test(`${target} mkdir retries EPERM, EACCES and EBUSY before holding the lock`, (t) => {
    injectedMkdir(
      t,
      target,
      ["EPERM", "EACCES", "EBUSY"],
      `await acquireLock(lock, { timeoutMs: 2000, fs: injectedFs });
assert.equal(calls, 4, "the injected mkdir must retry each transient error and then succeed");
assert.equal(await fs.readFile(join(lock, "pid"), "utf8"), String(process.pid));`,
    );
  });

  test(`${target} mkdir does not retry ENOTDIR`, (t) => {
    injectedMkdir(
      t,
      target,
      ["ENOTDIR"],
      `await assert.rejects(acquireLock(lock, { timeoutMs: 1000, fs: injectedFs }), error => error === failures[0]);
assert.equal(calls, 1);`,
    );
  });

  test(`${target} mkdir persistent EPERM times out`, (t) => {
    injectedMkdir(
      t,
      target,
      ["EPERM"],
      `await assert.rejects(acquireLock(lock, { timeoutMs: 50, fs: injectedFs }), /Timed out waiting for/);
assert.ok(calls >= 1, "the injected persistent error must be encountered before timing out");`,
      { persistent: true },
    );
  });
}
