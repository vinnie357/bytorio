import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyMacLoaderPaths } from "./macos-loader.mjs";

const checkout = "/checkout";
const portable = `/checkout/build/relocated player with spaces/player:
Mach header
Load command 0
          cmd LC_RPATH
      cmdsize 40
         path @executable_path (offset 12)
Load command 1
          cmd LC_LOAD_DYLIB
      cmdsize 64
         name @rpath/libSDL3.0.dylib (offset 24)
   time stamp 2 Thu Jan  1 00:00:02 1970
Load command 2
          cmd LC_LOAD_DYLIB
      cmdsize 56
         name /usr/lib/libSystem.B.dylib (offset 24)
`;

test("Mac loader verification ignores otool's absolute filename header", () => {
  assert.doesNotThrow(() => verifyMacLoaderPaths(portable, checkout));
});

test("Mac loader verification rejects checkout rpaths and library references", () => {
  for (const path of ["/checkout/build/libraries with spaces", "/checkout/libSDL3.0.dylib"]) {
    for (const original of ["@executable_path", "@rpath/libSDL3.0.dylib"]) {
      assert.throws(() => verifyMacLoaderPaths(portable.replace(original, path), checkout));
    }
  }
});

test("Mac loader verification rejects missing or empty load-command output", () => {
  assert.throws(() => verifyMacLoaderPaths("", checkout));
  assert.throws(() => verifyMacLoaderPaths("player:\nMach header\n", checkout));
});
