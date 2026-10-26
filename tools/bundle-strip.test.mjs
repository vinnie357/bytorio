import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { bundleLuau, stripComments } from "./sdk/bundle.mjs";
import { repo, tool } from "./toolchain.mjs";

const lines = (text) => text.split("\n");

test("line comments, trailing comments and indentation go, and every newline stays", () => {
  const source = "-- header\nlocal x = 1 -- trailing\n    local y = 2\n\t--- doc\nreturn x + y\n";
  const stripped = stripComments(source);
  assert.equal(stripped, "\nlocal x = 1\nlocal y = 2\n\nreturn x + y\n");
  assert.equal(lines(stripped).length, lines(source).length);
});

test("block and leveled long comments go with their newlines kept", () => {
  const source = [
    "local a = 1 --[[ one line ]] + 1",
    "--[[ two",
    "lines ]]",
    "--[==[ a ]] inside",
    "still inside ]==] local b = 2",
    "return a + b",
    "",
  ].join("\n");
  const stripped = stripComments(source);
  assert.equal(lines(stripped).length, lines(source).length);
  assert.equal(stripped, "local a = 1 + 1\n\n\n\nlocal b = 2\nreturn a + b\n");
});

test("comment markers inside strings are left alone, byte for byte", () => {
  const source = [
    `local a = "-- not a comment"`,
    `local b = '--[[ nor this ]]'`,
    `local c = "quote \\" -- still a string"`,
    "local d = [[ -- long",
    "    indented -- string ]]",
    "local e = [==[ --[[ ]] ]] ]==]",
    "local f = `-- {a} interpolated`",
    "return a",
    "",
  ].join("\n");
  assert.equal(stripComments(source), source);
});

test("indentation inside a long string is kept and indentation after it is not", () => {
  const source = "local s = [[\n    keep\n  me]]\n    return s -- gone\n";
  assert.equal(stripComments(source), "local s = [[\n    keep\n  me]]\nreturn s\n");
});

test("a profile directive on the first line survives and other directives are plain comments", () => {
  assert.equal(
    stripComments("--!console-profile=2\nlocal x = 1 --!strict\n"),
    "--!console-profile=2\nlocal x = 1\n",
  );
});

test("an unclosed comment or string is an error, as it is for the bundler", () => {
  assert.throws(() => stripComments("--[[ never closed"), /Unclosed/);
  assert.throws(() => stripComments('local s = "never closed'), /Unclosed/);
});

test("a runtime error reports the same line as the source", () => {
  const source = [
    "-- a comment",
    "--[[ a block",
    "   comment ]]",
    "local function fail()",
    "    -- inside",
    '    error("boom") -- the failing line',
    "end",
    "fail()",
    "",
  ].join("\n");
  const failingLine = lines(source).findIndex((line) => line.includes('error("boom")')) + 1;
  async function failure(text) {
    const directory = await mkdtemp(join(tmpdir(), "bundle-strip-"));
    const file = join(directory, "case.luau");
    await writeFile(file, text);
    const result = spawnSync(tool("luau"), [file], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    return Number(/case\.luau:(\d+):/.exec(result.stderr)?.[1]);
  }
  return Promise.all([failure(source), failure(stripComments(source))]).then(([before, after]) => {
    assert.equal(before, failingLine);
    assert.equal(after, failingLine);
  });
});

test("a real bundle is smaller, keeps its line count, and still compiles and runs through the SDK checks", async () => {
  const project = await mkdtemp(join(tmpdir(), "bundle-strip-project-"));
  await mkdir(join(project, "src"));
  const entry = join(project, "src/main.luau");
  await writeFile(
    entry,
    [
      "--!strict",
      "-- A game with comments that must not cost cartridge bytes.",
      'local byt = require("@bytorio")',
      'local helper = require("./helper") -- one more module',
      "local game = {}",
      "function game.init() end -- nothing to set up",
      "function game.update(input: any) end",
      "function game.draw() byt.gfx.clear(helper.color) end",
      "return game",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(project, "src/helper.luau"),
    "-- helper\nreturn { color = 1 } -- the clear colour\n",
  );
  const options = { entry, project, sdkRoot: resolve(repo, "sdk/luau"), assets: Buffer.alloc(0) };
  const plain = (await bundleLuau({ ...options, strip: false })).toString("utf8");
  const stripped = (await bundleLuau(options)).toString("utf8");
  assert.ok(
    stripped.length < plain.length * 0.9,
    `${stripped.length} bytes against ${plain.length}`,
  );
  assert.equal(lines(stripped).length, lines(plain).length, "line count");
  assert.ok(!/^\s*--(?!!)/m.test(stripped), "no comment-only lines remain");
  const file = join(project, "bundle.luau");
  await writeFile(file, stripped);
  const compiled = spawnSync(tool("luau-compile"), ["--text", file], {
    encoding: "utf8",
  });
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.equal(await readFile(file, "utf8"), stripped);
  // Comments never reach the bytecode, so the stripped and the plain bundle compile to the same bytes,
  // line information included.
  const reference = join(project, "plain.luau");
  await writeFile(reference, plain);
  const bytecode = (path) =>
    spawnSync(tool("luau-compile"), ["--binary", "-g1", path], { maxBuffer: 1 << 28 }).stdout;
  assert.ok(Buffer.compare(bytecode(file), bytecode(reference)) === 0, "the bytecode differs");
});
