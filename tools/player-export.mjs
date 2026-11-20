import { copyFile, cp, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  emscriptenRoot,
  nativePlayer,
  repo,
  sdlBuildRoot,
  sdlLibraryName,
  windowsHost,
} from "./toolchain.mjs";

const webScripts = [
  "player.html",
  "debug.html",
  "debug-player.js",
  "bootstrap.js",
  "runtime.js",
  "session.js",
  "input.js",
  "web-player.js",
  "player-input.js",
  "player-config.js",
  "worker.js",
  "policy.js",
  "audio-worklet.js",
  "ogg.js",
  "constants.js",
  "cartridge.js",
  "cartridge-cache.js",
  "save.js",
  "text-session.js",
  "text-input.js",
  "executor-cache.js",
  "executor-cache-core.js",
  "frame-clock.js",
  "gpu.js",
  "gpu-surface.js",
];
const shaders = [
  "fullscreen.vert",
  "initialize.frag",
  "mesh.vert",
  "mesh.frag",
  "resolve.frag",
  "resident.vert",
  "present.frag",
];
const binaries = {
  web: ["runtime.wasm", "runtime-gpu.wasm", "audio.wasm"],
  native: [nativePlayer, sdlLibraryName, ...(windowsHost ? ["wasmtime.dll"] : [])],
};

function supportFiles(platform) {
  if (platform === "web") {
    return [
      ...webScripts.map((name) => [name, "web", name]),
      ["custom-player.html", "example", "index.html"],
      ["custom-player.js", "example", "player.js"],
      ["vorbis.js", "vorbis", "vorbis.js"],
      ["vorbis.wasm", "vorbis", "vorbis.wasm"],
      ["licenses/vorbis.txt", "vorbis", "libvorbis-1.3.7/COPYING"],
      ["licenses/ogg.txt", "vorbis", "libogg-1.3.5/COPYING"],
      ["licenses/emscripten.txt", "emscripten", "LICENSE"],
      ["licenses/musl.txt", "emscripten", "system/lib/libc/musl/COPYRIGHT"],
      ...shaders.map((name) => [`gpu-shaders/${name}`, "shaders", name]),
      ["licenses/odin.txt", "compiler", "LICENSE"],
    ];
  }
  if (platform !== "native") {
    throw new Error("Player export platform must be web or native");
  }
  return [
    ["licenses/vorbis.txt", "vorbis", "libvorbis-1.3.7/COPYING"],
    ["licenses/ogg.txt", "vorbis", "libogg-1.3.5/COPYING"],
    ...(windowsHost
      ? [
          ["SDL3.dll", "compiler", "vendor/sdl3/SDL3.dll"],
          ["wasmtime.dll", "dependency", "wasmtime.dll"],
          ["licenses/sdl3.txt", "compiler", "vendor/sdl3/LICENSE.txt"],
        ]
      : [
          // Wasmtime is linked statically here, so only SDL3 travels beside the player.
          [sdlLibraryName, "sdl3", `install/lib/${sdlLibraryName}`],
          ["licenses/sdl3.txt", "sdl3", "SDL3-3.4.2/LICENSE.txt"],
        ]),
    ["licenses/wasmtime.txt", "dependency", "../LICENSE"],
    ["licenses/odin.txt", "compiler", "LICENSE"],
    ["licenses/opengl.txt", "compiler", "vendor/OpenGL/LICENSE"],
    ["licenses/glad.txt", "compiler", "vendor/OpenGL/LICENSE_glad"],
  ];
}

async function checkFiles(entries) {
  // Reject incomplete inputs before changing the destination. I/O failures during
  // copying still fail the build; this is not an atomic directory replacement.
  for (const [, source] of entries) {
    if (!(await stat(source)).isFile()) {
      throw new Error(`Player export input is not a file: ${source}`);
    }
  }
}

async function copyFiles(target, entries) {
  for (const [name, source] of entries) {
    const destination = resolve(target, name);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

// Complete a freshly compiled player with its host scripts and dependency notices.
export async function stagePlayerSupport({
  platform,
  target,
  compilerRoot,
  dependency,
  sdlRoot = sdlBuildRoot,
}) {
  const roots = {
    web: resolve(repo, "runtime/odin/web"),
    example: resolve(repo, "sdk/examples/custom-player"),
    shaders: resolve(repo, "runtime/odin/gpu"),
    compiler: compilerRoot,
    sdl3: sdlRoot,
    dependency,
    vorbis: resolve(repo, "build/vorbis"),
    emscripten: emscriptenRoot(),
  };
  const entries = supportFiles(platform).map(([name, origin, path]) => [
    name,
    resolve(roots[origin], path),
  ]);
  await checkFiles(entries);
  await copyFiles(target, entries);
  // Windows copies retain source mtimes, including old dependency licenses.
  // These are generated task outputs: date them when staging completes so
  // mise can recognize that they incorporate the current build recipe.
  const stagedAt = new Date();
  await Promise.all(entries.map(([name]) => utimes(resolve(target, name), stagedAt, stagedAt)));
}

// macOS refuses to load unsigned code that was modified after linking; sign the staged player
// and its SDL3 library ad hoc so a local export runs. Distribution signing is separate.
async function adHocSign(target) {
  if (process.platform !== "darwin") {
    return;
  }
  for (const name of [sdlLibraryName, nativePlayer]) {
    execFileSync("codesign", ["--force", "--sign", "-", resolve(target, name)], {
      stdio: "pipe",
      timeout: 120000,
    });
    execFileSync("codesign", ["--verify", "--strict", resolve(target, name)], {
      stdio: "pipe",
      timeout: 120000,
    });
  }
}

async function executorPayload() {
  const root = resolve(repo, "build/luau-executor");
  const emscripten = emscriptenRoot();
  return {
    bytes: await readFile(resolve(root, "luau-executor.wasm")),
    notices: [
      ["licenses/luau.txt", resolve(root, "_deps/luau-src/LICENSE.txt")],
      ["licenses/emscripten.txt", resolve(emscripten, "LICENSE")],
      ["licenses/libcxx.txt", resolve(emscripten, "system/lib/libcxx/LICENSE.TXT")],
      ["licenses/libcxxabi.txt", resolve(emscripten, "system/lib/libcxxabi/LICENSE.TXT")],
      ["licenses/musl.txt", resolve(emscripten, "system/lib/libc/musl/COPYRIGHT")],
    ],
  };
}

async function writeExecutor(target, payload) {
  await writeFile(resolve(target, "luau-executor.wasm"), payload.bytes);
  await writeFile(
    resolve(target, "executor-version.json"),
    JSON.stringify({ sha256: createHash("sha256").update(payload.bytes).digest("hex") }) + "\n",
  );
}

export async function exportExecutor({ target }) {
  const payload = await executorPayload();
  await checkFiles(payload.notices);
  await copyFiles(target, payload.notices);
  await writeExecutor(target, payload);
  return { notices: payload.notices.map(([name]) => name) };
}

// Export a built player. Game files, profiles and launcher customization belong
// to the caller; the player inventory and optional executor belong here.
export async function exportPlayer({ platform, source, target, luau = false, sign = adHocSign }) {
  if (resolve(source) === resolve(target)) {
    throw new Error("Player export source and target must differ");
  }
  const support = supportFiles(platform);
  const names = new Set([...binaries[platform], ...support.map(([name]) => name)]);
  const entries = [...names].map((name) => [name, resolve(source, name)]);
  let executor;
  if (luau) {
    executor = await executorPayload();
    entries.push(...executor.notices);
  }
  await checkFiles(entries);
  // Preserve additional notices, then let the selected dependencies' notices win.
  await cp(resolve(source, "licenses"), resolve(target, "licenses"), { recursive: true });
  await copyFiles(target, entries);
  if (platform === "native") {
    await sign(target);
  }
  if (executor) {
    await writeExecutor(target, executor);
  }
}
