import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { acquireLock } from "./directory-lock.mjs";
import { extractArchive } from "./extract-archive.mjs";
import { repo, run, tool } from "./toolchain.mjs";

const root = resolve(repo, "build/sdl3");
const stamp = resolve(root, "native.stamp");
await mkdir(root, { recursive: true });

// Windows ships Odin's vendored SDL3.dll. Other hosts link "system:SDL3", so the
// native player builds the pinned release here. 3.4.2 matches Odin's vendor:sdl3 bindings.
if (process.platform === "win32") {
  await writeFile(stamp, "Windows uses the SDL3 vendored with Odin.\n");
  console.log("Windows uses the SDL3 vendored with Odin.");
  process.exit(0);
}
// Parallel gates run this script at once; CMake cannot share one build folder between them.
await acquireLock(resolve(root, ".lock"));
const version = "3.4.2";
const hash = "ef39a2e3f9a8a78296c40da701967dd1b0d0d6e267e483863ce70f8a03b4050c";
const prefix = resolve(root, "install");

const archive = resolve(root, `SDL3-${version}.tar.gz`);
if (!existsSync(archive)) {
  const response = await fetch(
    `https://github.com/libsdl-org/SDL/releases/download/release-${version}/SDL3-${version}.tar.gz`,
    { signal: AbortSignal.timeout(120000) },
  );
  if (!response.ok) {
    throw new Error(`SDL3 download failed: ${response.status}`);
  }
  // Write beside the target and rename, so an interrupted download never looks complete.
  const partial = `${archive}.${process.pid}.part`;
  await writeFile(partial, Buffer.from(await response.arrayBuffer()));
  await rename(partial, archive);
}
if (
  createHash("sha256")
    .update(await readFile(archive))
    .digest("hex") !== hash
) {
  throw new Error("Invalid SDL3 archive hash");
}
const source = resolve(root, `SDL3-${version}`);
await extractArchive({ archive, directory: source });
const build = resolve(root, "build");
run(tool("cmake"), [
  "-S",
  source,
  "-B",
  build,
  "-G",
  "Ninja",
  `-DCMAKE_MAKE_PROGRAM=${tool("ninja")}`,
  "-DCMAKE_BUILD_TYPE=Release",
  `-DCMAKE_INSTALL_PREFIX=${prefix}`,
  "-DCMAKE_INSTALL_LIBDIR=lib",
  "-DSDL_SHARED=ON",
  "-DSDL_STATIC=OFF",
  "-DSDL_TESTS=OFF",
  "-DSDL_EXAMPLES=OFF",
]);
run(tool("cmake"), ["--build", build, "--target", "install", "--parallel", "4"]);
await writeFile(stamp, `SDL3 ${version}\n`);
console.log("Built SDL3.");
