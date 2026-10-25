import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const module = pathToFileURL(resolve("tools/directory-lock.mjs")).href;

// The lock releases on process exit, so each case runs in its own process.
function hold(lock, timeoutMs) {
  const script = `import { acquireLock } from ${JSON.stringify(module)};
await acquireLock(${JSON.stringify(lock)}, { timeoutMs: ${timeoutMs} });
console.log("held");`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
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
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script]);
    child.on("close", done);
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
      const codes = await Promise.all(
        Array.from({ length: waiters }, () => waiter(lock, join(root, "inside"), violations)),
      );
      assert.deepEqual(codes, Array(waiters).fill(0));
      assert.equal(existsSync(violations), false, `round ${round}: two holders at once`);
      assert.equal(existsSync(lock), false, "the last holder releases the lock");
    }
  });
}
