import { copyFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { timedSpawnSync as spawnSync } from "./command-timing.mjs";
import { hostPlatform, requireNativeHost } from "./host-platform.mjs";

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mise = process.env.MISE_BIN || "mise";
const paths = new Map();
export function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: repo,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message ||
        result.stderr ||
        result.stdout ||
        `${executable} exited ${result.status}`,
    );
  }
  return result.stdout;
}
function lookup(command, name) {
  const key = `${command}:${name}`;
  if (!paths.has(key)) {
    paths.set(key, run(mise, [command, name]).trim());
  }
  return paths.get(key);
}
export const tool = (name) => lookup("which", name);
export const toolRoot = (name) => lookup("where", name);
export const dependencyRoot = () => resolve(toolRoot("github:bytecodealliance/wasmtime"), "lib");
export const emscriptenRoot = () => resolve(toolRoot("vfox:jdx/vfox-emsdk"), "upstream/emscripten");
export const script = (file, args = []) =>
  run(process.execPath, [resolve(repo, file), ...args], { stdio: "inherit", timeout: 600000 });
export const task = (name) => run(mise, ["run", name], { stdio: "inherit", timeout: 600000 });

// Native player naming and libraries. Windows ships Odin's vendored SDL3.dll and links
// Wasmtime as a DLL. macOS builds SDL3 from source (deps:sdl3:native) and links Wasmtime
// statically, so only the SDL3 dylib travels beside the executable.
const host = hostPlatform();
export const windowsHost = host.windows;
export const nativePlayer = host.player;
export const sdlLibraryName = host.sdlLibrary;
export const sdlBuildRoot = resolve(repo, "build/sdl3");
export const sdlLibrary = () =>
  windowsHost
    ? resolve(toolRoot("odin"), "vendor/sdl3/SDL3.dll")
    : resolve(sdlBuildRoot, "install/lib", sdlLibraryName);
// Extra Odin linker flags that find the SDL3 build and load it from beside the executable. A
// test harness also records the build directory as a second rpath so it runs from any scratch
// folder; shipped players must not embed that machine path.
export const nativeLinkerFlags = ({ harness = false } = {}) => {
  requireNativeHost();
  if (windowsHost) {
    return [];
  }
  const library = resolve(sdlBuildRoot, "install/lib");
  const rpaths = ["@executable_path", ...(harness ? [library] : [])];
  const flags = rpaths.map((path) => `-Wl,-rpath,"${path}"`).join(" ");
  return [`-extra-linker-flags:-L"${library}" ${flags}`];
};

// Verifiers run harness executables from a scratch directory; these place the libraries they load
// beside them. Wasmtime is linked statically off Windows, so only Windows needs it copied.
export async function copySdlLibrary(directory) {
  await copyFile(sdlLibrary(), resolve(directory, sdlLibraryName));
}
export async function copyWasmtimeLibrary(directory) {
  if (windowsHost) {
    await copyFile(resolve(dependencyRoot(), "wasmtime.dll"), resolve(directory, "wasmtime.dll"));
  }
}
