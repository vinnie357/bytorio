import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractArchive } from "./extract-archive.mjs";

// A small archive laid out like the Xiph tarballs: one top-level folder named after the library.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "extract-archive-"));
  const source = join(root, "source/libdemo-1.0");
  mkdirSync(join(source, "src"), { recursive: true });
  writeFileSync(join(source, "CMakeLists.txt"), "project(demo)\n");
  writeFileSync(join(source, "src/demo.c"), "int demo(void) { return 1; }\n");
  const archive = join(root, "libdemo-1.0.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", join(root, "source"), "libdemo-1.0"]);
  return { root, archive, directory: join(root, "libdemo-1.0") };
}

test("a half-extracted folder is rebuilt rather than reused", async () => {
  const { root, archive, directory } = fixture();
  mkdirSync(directory);
  writeFileSync(join(directory, "CMakeLists.txt"), "truncated");
  await extractArchive({ archive, directory });
  assert.equal(
    readFileSync(join(directory, "src/demo.c"), "utf8"),
    "int demo(void) { return 1; }\n",
  );
  assert.equal(readFileSync(join(directory, "CMakeLists.txt"), "utf8"), "project(demo)\n");
  assert.deepEqual(
    readdirSync(root).filter((name) => name.includes("tmp")),
    [],
  );
});

test("a completed folder is reused without extracting again", async () => {
  const { archive, directory } = fixture();
  await extractArchive({ archive, directory });
  writeFileSync(join(directory, "local-edit.txt"), "kept");
  await extractArchive({ archive, directory });
  assert.equal(readFileSync(join(directory, "local-edit.txt"), "utf8"), "kept");
});

test("concurrent runs all succeed and leave one complete folder", async () => {
  const { root, archive, directory } = fixture();
  await Promise.all(Array.from({ length: 6 }, () => extractArchive({ archive, directory })));
  assert.ok(existsSync(join(directory, "src/demo.c")));
  assert.deepEqual(
    readdirSync(root).filter((name) => /tmp|stale/.test(name)),
    [],
  );
});

test("concurrent runs over a half-extracted folder all succeed", async () => {
  const { root, archive, directory } = fixture();
  mkdirSync(directory);
  writeFileSync(join(directory, "CMakeLists.txt"), "truncated");
  await Promise.all(Array.from({ length: 6 }, () => extractArchive({ archive, directory })));
  assert.ok(existsSync(join(directory, "src/demo.c")));
  assert.deepEqual(
    readdirSync(root).filter((name) => /tmp|stale/.test(name)),
    [],
  );
});

test("a corrupt archive fails without leaving a target folder", async () => {
  const { root, directory } = fixture();
  const archive = join(root, "broken.tar.gz");
  writeFileSync(archive, "not an archive");
  await assert.rejects(extractArchive({ archive, directory }));
  assert.equal(existsSync(directory), false);
  assert.deepEqual(
    readdirSync(root).filter((name) => /tmp|stale/.test(name)),
    [],
  );
});
