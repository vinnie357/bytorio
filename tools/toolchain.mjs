import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { timedSpawnSync as spawnSync } from "./command-timing.mjs";

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
export const windowsHost = process.platform === "win32";
export const nativePlayer = windowsHost ? "player.exe" : "player";
export const sdlLibraryName = windowsHost ? "SDL3.dll" : "libSDL3.0.dylib";
export const sdlBuildRoot = resolve(repo, "build/sdl3");
export const sdlLibrary = () =>
  windowsHost
    ? resolve(toolRoot("odin"), "vendor/sdl3/SDL3.dll")
    : resolve(sdlBuildRoot, "install/lib", sdlLibraryName);
// Extra Odin linker flags that find the SDL3 build and load it from beside the executable.
export const nativeLinkerFlags = () =>
  windowsHost
    ? []
    : [`-extra-linker-flags:-L${resolve(sdlBuildRoot, "install/lib")} -Wl,-rpath,@executable_path`];
