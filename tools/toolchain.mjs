import { readFileSync, rmSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { timedSpawnSync as spawnSync } from "./command-timing.mjs";

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mise = process.env.MISE_BIN || "mise";
const paths = new Map();
export const commandTimeout = 120000;

const timeoutWatchdog = `
sleep "$1"
mkdir -p "$2"
for pid in $(pgrep -P "$3"); do
  if [ "$pid" = "$$" ]; then
    continue
  fi
  ps -o pid=,stat=,etime=,time=,rss=,command= -p "$pid" >> "$4"
  # Without -file, sample writes its analysis to a file of its own under /tmp.
  if command -v sample >/dev/null 2>&1; then
    sample "$pid" 1 -file "$4.sample" >/dev/null 2>&1 && cat "$4.sample" >> "$4"
    rm -f "$4.sample"
  fi
done
`;
// Job control isolates the watchdog group; exec preserves its marker in argv.
const watchdogLauncher = `
set -m
( exec /bin/sh -c "$1" "$0" "$2" "$3" "$4" "$5" ) </dev/null >/dev/null 2>&1 &
printf '%s\\n' "$!"
`;

export function run(executable, args, options = {}) {
  const settings = {
    cwd: repo,
    encoding: "utf8",
    timeout: commandTimeout,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  };
  const folder =
    process.env.BYTORIO_COMMAND_TIMEOUT_REPORTS || resolve(repo, "build/command-timeouts");
  const report = resolve(
    folder,
    `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}.txt`,
  );
  let watchdog;
  const started = Date.now();
  if (settings.timeout && process.platform !== "win32") {
    const delay = (settings.timeout - Math.min(10000, settings.timeout / 2)) / 1000;
    const launched = spawnSync(
      "/bin/sh",
      [
        "-c",
        watchdogLauncher,
        `bytorio-watchdog-${process.pid}`,
        timeoutWatchdog,
        String(delay),
        folder,
        String(process.pid),
        report,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    watchdog = Number(launched.stdout?.trim()) || undefined;
  }
  let result;
  try {
    result = spawnSync(executable, args, settings);
  } finally {
    if (watchdog) {
      try {
        // Kill sleep and sample too, without replacing a command's error.
        process.kill(-watchdog, "SIGKILL");
      } catch {
        // Already gone; never replace the command's own error.
      }
    }
  }
  if (result.error?.code === "ETIMEDOUT") {
    let contents = "";
    try {
      contents = readFileSync(report, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    const lines = contents.split("\n");
    const evidence = lines.filter((line) =>
      /^\s*\d+\s+\S+\s+[\d:-]+\s+[\d:.]+\s+\d+\s+/.test(line),
    );
    const graph = lines.findIndex((line) => line.includes("Call graph:"));
    const summary = evidence.map((line) => line.trim()).join("; ");
    throw new Error(
      [
        `${result.error.message} after ${Date.now() - started} ms`,
        ...evidence,
        ...(graph < 0 ? [] : lines.slice(graph, graph + 26)),
        `stuck: ${summary || "no process evidence was captured"} | report: ${report}`,
      ].join("\n"),
    );
  }
  if (watchdog) {
    rmSync(report, { force: true });
  }
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
// Wasmtime as a DLL. macOS and Linux build SDL3 from source (deps:sdl3:native) and link Wasmtime
// statically, so only the SDL3 library travels beside the executable.
export const windowsHost = process.platform === "win32";
export const nativePlayer = windowsHost ? "player.exe" : "player";
export const darwinHost = process.platform === "darwin";
export const sdlLibraryName = windowsHost
  ? "SDL3.dll"
  : darwinHost
    ? "libSDL3.0.dylib"
    : "libSDL3.so.0";
export const sdlBuildRoot = resolve(repo, "build/sdl3");
export const sdlLibrary = () =>
  windowsHost
    ? resolve(toolRoot("odin"), "vendor/sdl3/SDL3.dll")
    : resolve(sdlBuildRoot, "install/lib", sdlLibraryName);
// Extra Odin linker flags that find the SDL3 build and load it from beside the executable. A
// test harness also records the build directory as a second rpath so it runs from any scratch
// folder; shipped players must not embed that machine path.
export const nativeLinkerFlags = ({ harness = false } = {}) => {
  if (windowsHost) {
    return [];
  }
  const library = resolve(sdlBuildRoot, "install/lib");
  // Odin already adds $ORIGIN to every Linux executable.
  const rpaths = [...(darwinHost ? ["@executable_path"] : []), ...(harness ? [library] : [])];
  const flags = rpaths.map((path) => `-Wl,-rpath,${path}`).join(" ");
  return [`-extra-linker-flags:-L${library} ${flags}`];
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
