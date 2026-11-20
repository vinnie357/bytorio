import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { repo, run, tool } from "./toolchain.mjs";
import { resourceSchema as limits } from "../runtime/odin/web/constants.js";

// Windows uses the Visual Studio generator; Unix single-config builds need an explicit build type.
const nativeConfigureFlags =
  process.platform === "win32"
    ? ["-A", "x64", "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded"]
    : ["-DCMAKE_BUILD_TYPE=Release"];
const root = resolve(repo, "build/vorbis");
const prefix = resolve(root, "install");
const bridge = resolve(repo, "runtime/vorbis");
await mkdir(root, { recursive: true });

// The native player links this bridge after the decoder dependencies are installed.
if (process.argv.includes("--bridge")) {
  run(tool("cmake"), [
    "-S",
    bridge,
    "-B",
    resolve(root, "native"),
    ...nativeConfigureFlags,
    `-DCMAKE_PREFIX_PATH=${prefix}`,
  ]);
  run(tool("cmake"), [
    "--build",
    resolve(root, "native"),
    "--config",
    "Release",
    "--parallel",
    "4",
  ]);
  const archive = resolve(
    root,
    "native",
    process.platform === "win32" ? "Release/bytorio-vorbis.lib" : "libbytorio-vorbis.a",
  );
  const completed = new Date();
  await utimes(archive, completed, completed);
  console.log("Built native Vorbis bridge.");
  process.exit(0);
}
for (const [name, version, hash] of [
  ["libogg", "1.3.5", "c4d91be36fc8e54deae7575241e03f4211eb102afb3fc0775fbbc1b740016705"],
  ["libvorbis", "1.3.7", "b33cc4934322bcbf6efcbacf49e3ca01aadbea4114ec9589d1b1e9d20f72954b"],
]) {
  const archive = resolve(root, `${name}-${version}.tar.xz`);
  if (!existsSync(archive)) {
    const response = await fetch(
      `https://downloads.xiph.org/releases/${name === "libogg" ? "ogg" : "vorbis"}/${name}-${version}.tar.xz`,
      { signal: AbortSignal.timeout(120000) },
    );
    if (!response.ok) {
      throw new Error(`Vorbis download failed: ${response.status}`);
    }
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
  }
  if (
    createHash("sha256")
      .update(await readFile(archive))
      .digest("hex") !== hash
  ) {
    throw new Error(`Invalid ${name} archive hash`);
  }
  const source = resolve(root, `${name}-${version}`);
  if (!existsSync(source)) {
    run("tar", ["-xf", archive, "-C", root]);
  }
  const build = resolve(root, `${name}-native`);
  run(tool("cmake"), [
    "-S",
    source,
    "-B",
    build,
    ...nativeConfigureFlags,
    "-DCMAKE_POLICY_VERSION_MINIMUM=3.5",
    "-DCMAKE_POLICY_DEFAULT_CMP0091=NEW",
    `-DCMAKE_INSTALL_PREFIX=${prefix}`,
    `-DCMAKE_PREFIX_PATH=${prefix}`,
    "-DBUILD_TESTING=OFF",
    "-DBUILD_SHARED_LIBS=OFF",
  ]);
  run(tool("cmake"), [
    "--build",
    build,
    "--config",
    "Release",
    "--target",
    "install",
    "--parallel",
    "4",
  ]);
}
const completed = new Date();
for (const name of process.platform === "win32"
  ? ["ogg.lib", "vorbis.lib", "vorbisfile.lib"]
  : ["libogg.a", "libvorbis.a", "libvorbisfile.a"]) {
  await utimes(resolve(prefix, "lib", name), completed, completed);
}
const sources = [
  "mdct",
  "smallft",
  "block",
  "envelope",
  "window",
  "lsp",
  "lpc",
  "analysis",
  "synthesis",
  "psy",
  "info",
  "floor1",
  "floor0",
  "res0",
  "mapping0",
  "registry",
  "codebook",
  "sharedbook",
  "lookup",
  "bitrate",
  "vorbisfile",
];
run(tool("emcc"), [
  resolve(bridge, "decoder.c"),
  ...sources.map((name) => resolve(root, `libvorbis-1.3.7/lib/${name}.c`)),
  resolve(root, "libogg-1.3.5/src/bitwise.c"),
  resolve(root, "libogg-1.3.5/src/framing.c"),
  `-I${resolve(root, "libvorbis-1.3.7/include")}`,
  `-I${resolve(root, "libogg-1.3.5/include")}`,
  `-I${resolve(prefix, "include")}`,
  "-O3",
  "-sMODULARIZE=1",
  "-sEXPORT_ES6=1",
  "-sENVIRONMENT=worker",
  "-sFILESYSTEM=0",
  `-sINITIAL_MEMORY=${limits.maxOggDecoderBytes}`,
  "-sALLOW_MEMORY_GROWTH=0",
  "-sEXPORTED_FUNCTIONS=['_malloc','_free']",
  "-sEXPORTED_RUNTIME_METHODS=['HEAPU8','HEAPF32']",
  "-o",
  resolve(root, "vorbis.js"),
]);
console.log("Built browser Vorbis decoder adapter.");
