import assert from "node:assert/strict";
import test from "node:test";
import * as commandTiming from "./command-timing.mjs";

for (const [path, name, expected] of [
  ["/x/stylua", "stylua", true],
  ["C:\\x\\stylua.exe", "stylua", true],
  ["C:\\x\\STYLUA.EXE", "stylua", true],
  ["/x/stylua-wrapper", "stylua", false],
  ["/x/notstylua", "stylua", false],
  ["stylua", "stylua", true],
  ["C:/x/stylua.exe", "stylua", true],
  ["/x/stylua.exe.bak", "stylua", false],
  ["C:\\x\\CLANG-FORMAT.EXE", "clang-format", true],
  ["/x/stylua", "clang-format", false],
]) {
  test(`executableIs(${JSON.stringify(path)}, ${JSON.stringify(name)}) is ${expected}`, () => {
    assert.equal(
      typeof commandTiming.executableIs,
      "function",
      "command-timing.mjs must export executableIs",
    );
    assert.equal(commandTiming.executableIs(path, name), expected);
  });
}
