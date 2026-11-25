import assert from "node:assert/strict";
import test from "node:test";
import * as atomic from "./atomic-file.mjs";

const from = "staged.txt";
const to = "destination.txt";

function replacementRename() {
  assert.equal(
    typeof atomic.renameReplacing,
    "function",
    "atomic-file.mjs must export renameReplacing",
  );
  return atomic.renameReplacing;
}

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test(`renameReplacing retries ${code} twice and succeeds on the third call`, async () => {
    const renameReplacing = replacementRename();
    const failure = Object.assign(new Error("destination is held open"), { code });
    const calls = [];
    const rename = async (source, destination) => {
      calls.push([source, destination]);
      if (calls.length <= 2) {
        throw failure;
      }
    };
    await renameReplacing(from, to, { rename, attempts: 4, delayMs: 0 });
    assert.deepEqual(calls, [
      [from, to],
      [from, to],
      [from, to],
    ]);
  });
}

for (const code of ["ENOENT", "EIO", undefined]) {
  test(`renameReplacing does not retry an error with code ${String(code)}`, async () => {
    const renameReplacing = replacementRename();
    const failure = Object.assign(new Error("rename failed"), { code });
    let calls = 0;
    const rename = async (source, destination) => {
      calls++;
      assert.equal(source, from);
      assert.equal(destination, to);
      throw failure;
    };
    await assert.rejects(
      renameReplacing(from, to, { rename, attempts: 4, delayMs: 0 }),
      (error) => error === failure,
    );
    assert.equal(calls, 1);
  });
}

for (const attempts of [1, 4]) {
  test(`renameReplacing preserves persistent EPERM after exactly ${attempts} calls`, async () => {
    const renameReplacing = replacementRename();
    const failure = Object.assign(new Error("destination remains held open"), { code: "EPERM" });
    let calls = 0;
    const rename = async (source, destination) => {
      calls++;
      assert.equal(source, from);
      assert.equal(destination, to);
      throw failure;
    };
    await assert.rejects(
      renameReplacing(from, to, { rename, attempts, delayMs: 0 }),
      (error) => error === failure,
    );
    assert.equal(calls, attempts);
  });
}

test("copyAtomic publishes through renameReplacing", () => {
  assert.match(
    atomic.copyAtomic.toString(),
    /\brenameReplacing\s*\(/,
    "copyAtomic must publish through renameReplacing",
  );
});
