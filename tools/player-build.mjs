import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { MAX_CARTRIDGE_BYTES, resourceSchema as limits } from "../runtime/odin/web/constants.js";
import { dependencyRoot, repo, run, tool } from "./toolchain.mjs";

const artifact = process.argv[2];
const web = resolve(repo, "build/odin-player/web");
const native = resolve(repo, "build/odin-player/native");
const odin = tool("odin");
const common = [
  "-o:speed",
  "-source-code-locations:filename",
  `-collection:sdk=${resolve(repo, "sdk/odin")}`,
];
const wasm = ["-target:freestanding_wasm32", "-no-entry-point", ...common];
const guest = [
  "-target:freestanding_wasm32",
  "-no-entry-point",
  "-o:minimal",
  "-source-code-locations:filename",
  `-collection:sdk=${resolve(repo, "sdk/odin")}`,
];
// Immutable cartridge backing is separate from the existing renderer/resource
// allowance. This host memory ceiling does not alter any guest or resource quota.
const hostMemoryBytes = Math.ceil((limits.maxRuntimeBytes + MAX_CARTRIDGE_BYTES) / 65536) * 65536;

if (!run(odin, ["version"]).includes("84bc3fc")) {
  throw new Error("Odin dev-2026-10 (84bc3fc) is required");
}

// Windows links Odin's vendored SDL3.lib. Other hosts link the pinned build under build/sdl3
// and load it from beside the executable.
function nativeLinkerFlags() {
  if (process.platform === "win32") {
    return [];
  }
  const sdl = resolve(repo, "build/sdl3/install/lib");
  return [`-extra-linker-flags:-L${sdl} -Wl,-rpath,@executable_path`];
}

async function build(source, flags, output) {
  await mkdir(dirname(output), { recursive: true });
  run(odin, ["build", source, ...flags, `-out:${output}`], { stdio: "inherit" });
}

switch (artifact) {
  case "web-cpu":
  case "web-gpu":
    await build(
      "runtime/odin/web",
      [
        ...wasm,
        ...(artifact === "web-gpu" ? ["-define:GPU_RASTER=true"] : []),
        `-extra-linker-flags:--max-memory=${hostMemoryBytes}`,
      ],
      resolve(web, artifact === "web-gpu" ? "runtime-gpu.wasm" : "runtime.wasm"),
    );
    break;
  case "web-audio":
    await build(
      "runtime/odin/audio_web",
      [...wasm, `-extra-linker-flags:--max-memory=${limits.maxAudioRuntimeBytes}`],
      resolve(web, "audio.wasm"),
    );
    break;
  case "native":
    await build(
      "runtime/odin/native",
      [...common, `-collection:deps=${dependencyRoot()}`, ...nativeLinkerFlags()],
      resolve(native, process.platform === "win32" ? "player.exe" : "player"),
    );
    break;
  case "hello":
    await build(
      "examples/hello/odin",
      [...guest, "-extra-linker-flags:--max-memory=8388608"],
      resolve(web, "game.wasm"),
    );
    await mkdir(native, { recursive: true });
    await copyFile(resolve(web, "game.wasm"), resolve(native, "game.wasm"));
    break;
  case "fixtures": {
    const kinds = [
      "loop",
      "abi",
      "offset",
      "command",
      "trap",
      "list-count",
      "list-offset",
      "list-command",
    ];
    for (const [index, kind] of kinds.entries()) {
      await build(
        "tests/odin/fixtures",
        [...guest, `-define:TEST_FAULT=${index + 1}`, "-extra-linker-flags:--max-memory=8388608"],
        resolve(web, "fixtures", `${kind}.wasm`),
      );
    }
    break;
  }
  default:
    throw new Error(`Unknown player artifact: ${artifact}`);
}
