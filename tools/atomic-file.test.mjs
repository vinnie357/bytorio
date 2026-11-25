import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename as fsRename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("renameReplacing succeeds on the first call without retrying", async () => {
  const renameReplacing = replacementRename();
  const calls = [];
  const rename = async (source, destination) => {
    calls.push([source, destination]);
  };
  await renameReplacing(from, to, { rename, attempts: 4, delayMs: 0 });
  assert.deepEqual(calls, [[from, to]]);
});

test("renameReplacing defaults retry twice with a non-zero bounded delay", async () => {
  const renameReplacing = replacementRename();
  const failure = Object.assign(new Error("destination is held open"), { code: "EPERM" });
  const times = [];
  const rename = async (source, destination) => {
    assert.equal(source, from);
    assert.equal(destination, to);
    times.push(performance.now());
    if (times.length <= 2) {
      throw failure;
    }
  };
  await renameReplacing(from, to, { rename });
  assert.equal(times.length, 3);
  const elapsed = times[2] - times[0];
  assert.ok(elapsed >= 1, `${elapsed} ms: defaults must wait between retries`);
  assert.ok(elapsed < 500, `${elapsed} ms: two default retry delays must stay below 500 ms`);
});

test("renameReplacing waits for a positive delayMs between attempts", async () => {
  const renameReplacing = replacementRename();
  const delayMs = 5;
  const retries = 2;
  const failure = Object.assign(new Error("destination is held open"), { code: "EBUSY" });
  const times = [];
  const rename = async () => {
    times.push(performance.now());
    if (times.length <= retries) {
      throw failure;
    }
  };
  await renameReplacing(from, to, { rename, attempts: retries + 1, delayMs });
  assert.equal(times.length, retries + 1);
  const elapsed = times.at(-1) - times[0];
  // Timer granularity can fire slightly before the requested deadline.
  assert.ok(
    elapsed >= delayMs * retries - 2,
    `${elapsed} ms: ${retries} retries should wait roughly ${delayMs * retries} ms`,
  );
});

for (const attempts of [0, -1, 1.5]) {
  test(`renameReplacing rejects invalid attempts ${attempts} before calling rename`, async () => {
    const renameReplacing = replacementRename();
    let calls = 0;
    const rename = async () => {
      calls++;
    };
    await assert.rejects(
      renameReplacing(from, to, { rename, attempts, delayMs: 0 }),
      (error) => error instanceof TypeError || error instanceof RangeError,
    );
    assert.equal(calls, 0);
  });
}

test("copyAtomic retries publication, replaces the content and removes its temporary folder", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atomic-file-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source.txt");
  const destination = join(directory, "destination.txt");
  await writeFile(source, "new content");
  await writeFile(destination, "old content");
  const failure = Object.assign(new Error("destination is held open"), { code: "EPERM" });
  let calls = 0;
  const rename = async (temporary, target) => {
    calls++;
    assert.equal(target, destination);
    assert.notEqual(temporary, source);
    assert.equal(await readFile(temporary, "utf8"), "new content");
    assert.equal(await readFile(destination, "utf8"), "old content");
    if (calls === 1) {
      throw failure;
    }
    await fsRename(temporary, target);
  };
  await atomic.copyAtomic(source, destination, { rename });
  assert.equal(await readFile(destination, "utf8"), "new content");
  assert.equal(calls, 2, "copyAtomic must use the injected rename and retry EPERM");
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.startsWith(".tmp-")),
    [],
  );
});
