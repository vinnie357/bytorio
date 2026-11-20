import assert from "node:assert/strict";
import { test } from "node:test";
import { hostPlatform, requireCliHost, requireNativeHost } from "./host-platform.mjs";

test("hosts separate CLI assets from native compiler availability", () => {
  for (const [os, arch, id, executable, player, library, archive] of [
    [
      "win32",
      "x64",
      "windows-x64",
      "byt.exe",
      "player.exe",
      "SDL3.dll",
      "byt-windows-x86_64.tar.gz",
    ],
    [
      "darwin",
      "arm64",
      "macos-arm64",
      "byt",
      "player",
      "libSDL3.0.dylib",
      "byt-macos-aarch64.tar.gz",
    ],
    ["darwin", "x64", "macos-x64", "byt", "player", "libSDL3.0.dylib", "byt-macos-x86_64.tar.gz"],
  ]) {
    const host = requireCliHost(os, arch);
    assert.equal(host.id, id);
    assert.equal(host.executable, executable);
    assert.equal(host.cliArchive, archive);
    assert.equal(host.player, player);
    assert.equal(host.sdlLibrary, library);
    assert.equal(host.cliSupported, true);
    assert.equal(host.supported, id !== "macos-x64");
    if (host.supported) {
      assert.deepEqual(requireNativeHost(os, arch), host);
    } else {
      assert.throws(() => requireNativeHost(os, arch), /Unsupported host/);
    }
  }
  for (const [os, arch] of [
    ["linux", "x64"],
    ["win32", "arm64"],
    ["darwin", "ia32"],
  ]) {
    assert.equal(hostPlatform(os, arch).supported, false);
    assert.equal(hostPlatform(os, arch).cliSupported, false);
    assert.throws(() => requireCliHost(os, arch), /Unsupported CLI host/);
    assert.throws(() => requireNativeHost(os, arch), /Unsupported host/);
  }
});
