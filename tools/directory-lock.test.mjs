import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
