import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { branding } from "../branding.mjs";
import { requireNativeHost } from "../host-platform.mjs";
import { exportExecutor, exportPlayer } from "../player-export.mjs";
import { emscriptenRoot, repo, run, tool, toolRoot } from "../toolchain.mjs";
import { packComponent } from "./component.mjs";
import { copyOdinDistribution } from "./compiler.mjs";
import { parseSdkManifest, sdkReleaseVersion } from "../cli/sdk-manifest.mjs";
import { dependencyNotices } from "../dependency-notices.mjs";

// Produce a host-qualified candidate. Publishing and cross-host assembly are separate steps.
export async function produceHostSdk({ version, cliVersionRange, output }) {
  sdkReleaseVersion(version);
  const host = requireNativeHost();
  if (!output) {
    throw new Error("SDK candidate output directory is required");
  }
  const ref = (component, path) => ({ component, path });
  const contract = JSON.parse(await readFile(resolve(repo, "sdk/contract.json"), "utf8"));
  const analyzer = basename(tool("luau-analyze"));
  const toolsId = `luau-${host.id}`;
  const odinId = `odin-${host.id}`;
  const nativeId = `native-${host.id}`;
  const compiler = basename(tool("odin"));
  if (!run(tool("odin"), ["version"]).includes("84bc3fc")) {
    throw new Error("Odin dev-2026-10 (84bc3fc) is required to produce this SDK");
  }
  const manifest = {
    schema: 2,
    version,
    cliProtocol: 2,
    cliVersionRange,
    profiles: contract.profiles,
    limits: contract.limits,
    defaults: {
      profile: contract.profile,
      display: contract.defaultDisplayMode,
      assets: ref("core", "sdk/templates/assets.json"),
    },
    starters: {
      luau: {
        entry: "src/main.luau",
        source: (await readFile(resolve(repo, "sdk/templates/main.luau"), "utf8")).replaceAll(
          "__STARTER_MESSAGE__",
          branding.starterMessage,
        ),
      },
      odin: {
        entry: "src/main.odin",
        source: (await readFile(resolve(repo, "sdk/templates/main.odin"), "utf8")).replaceAll(
          "__STARTER_MESSAGE__",
          branding.starterMessage,
        ),
      },
    },
    components: {},
    authoring: ref("core", "authoring.mjs"),
    contract: ref("core", "sdk/contract.json"),
    check: {
      runtime: ref("checks", "runtime.wasm"),
      workers: {
        luau: ref("checks", "check-worker.mjs"),
        odin: ref("checks", "check-worker.mjs"),
      },
      luauExecutor: ref("executor", "luau-executor.wasm"),
    },
    web: {
      runtime: ref("web", "runtime.js"),
      player: ref("web", "web-player.js"),
      page: ref("web", "player.html"),
    },
    languages: {
      luau: {
        libraries: ref("core", "sdk/luau"),
        hosts: { [host.id]: { analyzer: ref(toolsId, analyzer) } },
      },
      odin: {
        libraries: ref("core", "sdk/odin"),
        hosts: {
          [host.id]: {
            compiler: ref(odinId, compiler),
            linker: ref(odinId, `bin/wasm-ld${host.windows ? ".exe" : ""}`),
          },
        },
      },
    },
    native: { [host.id]: ref(nativeId, host.player) },
  };
  // Validate caller metadata before reserving the output or invoking a build.
  const placeholder = {
    asset: "candidate.tar.gz",
    format: "tar.gz",
    bytes: 1,
    expandedBytes: 1,
    files: 1,
    sha256: "0".repeat(64),
    inventorySha256: "0".repeat(64),
  };
  const ids = ["core", toolsId, odinId, "checks", "executor", "web", nativeId];
  manifest.components = Object.fromEntries(ids.map((id) => [id, placeholder]));
  parseSdkManifest(Buffer.from(JSON.stringify(manifest)), version);

  output = resolve(output);
  await mkdir(output); // Exclusive reservation: never replace an earlier candidate.
  const payloads = resolve(output, ".payloads");
  try {
    for (const id of ids) {
      await mkdir(resolve(payloads, id), { recursive: true });
    }
    const core = resolve(payloads, "core");
    await writeFile(resolve(core, "THIRD-PARTY-NOTICES.txt"), await dependencyNotices());
    await cp(resolve(repo, "sdk"), resolve(core, "sdk"), { recursive: true });
    // SDK libraries share these implementation packages with the runtime.
    // Preserve their relative imports without shipping the contributor checkout.
    for (const name of [
      "abi",
      "audio",
      "cartridge",
      "core",
      "graphics",
      "resource_protocol",
      "resources",
    ]) {
      await cp(resolve(repo, "runtime/odin", name), resolve(core, "runtime/odin", name), {
        recursive: true,
      });
    }
    run(tool("bun"), [
      "build",
      "--target=bun",
      "tools/sdk/authoring.mjs",
      "--outfile",
      resolve(core, "authoring.mjs"),
    ]);
    const checks = resolve(payloads, "checks");
    await copyFile(
      resolve(repo, "build/odin-player/web/runtime.wasm"),
      resolve(checks, "runtime.wasm"),
    );
    await mkdir(resolve(checks, "licenses"));
    await copyFile(
      resolve(repo, "build/odin-player/web/licenses/odin.txt"),
      resolve(checks, "licenses/odin.txt"),
    );
    run(tool("bun"), [
      "build",
      "--target=bun",
      "tools/sdk/smoke-worker.mjs",
      "--outfile",
      resolve(checks, "check-worker.mjs"),
    ]);
    const executor = await exportExecutor({ target: resolve(payloads, "executor") });
    await copyFile(tool("luau-analyze"), resolve(payloads, toolsId, analyzer));
    await mkdir(resolve(payloads, toolsId, "licenses"));
    await copyFile(
      resolve(repo, "build/luau-executor/_deps/luau-src/LICENSE.txt"),
      resolve(payloads, toolsId, "licenses/luau.txt"),
    );
    const compilerRoot = toolRoot("odin");
    const compilerTarget = resolve(payloads, odinId);
    await copyOdinDistribution(compilerRoot, compilerTarget);
    const linker = `bin/wasm-ld${host.windows ? ".exe" : ""}`;
    await mkdir(resolve(compilerTarget, "bin"));
    const linkerSource = host.windows
      ? resolve(compilerRoot, linker)
      : resolve(emscriptenRoot(), "../bin/wasm-ld");
    await copyFile(linkerSource, resolve(compilerTarget, linker));
    await mkdir(resolve(compilerTarget, "licenses"));
    await copyFile(
      resolve(emscriptenRoot(), "system/lib/compiler-rt/LICENSE.TXT"),
      resolve(compilerTarget, "licenses/llvm.txt"),
    );
    await exportPlayer({
      platform: "web",
      source: resolve(repo, "build/odin-player/web"),
      target: resolve(payloads, "web"),
    });
    await exportPlayer({
      platform: "native",
      source: resolve(repo, "build/odin-player/native"),
      target: resolve(payloads, nativeId),
    });
    const webNotices = (await readdir(resolve(payloads, "web/licenses"))).map(
      (name) => `licenses/${name}`,
    );
    const notices = {
      core: ["sdk/NOTICE", "THIRD-PARTY-NOTICES.txt"],
      [toolsId]: ["licenses/luau.txt"],
      [odinId]: ["LICENSE", "base/runtime/LICENSE-compiler-rt.txt", "licenses/llvm.txt"],
      checks: ["licenses/odin.txt"],
      executor: executor.notices,
      web: webNotices,
      [nativeId]: (await readdir(resolve(payloads, nativeId, "licenses"))).map(
        (name) => `licenses/${name}`,
      ),
    };
    const executables = {
      [toolsId]: [analyzer],
      [odinId]: [compiler, linker],
      [nativeId]: [host.player, ...(!host.windows ? [host.sdlLibrary] : [])],
    };
    const archives = new Map();
    for (const id of ids) {
      const asset = `bytorio-sdk-${version}-${id}.tar.gz`;
      const archive = resolve(output, asset);
      manifest.components[id] = {
        asset,
        ...(await packComponent({
          root: resolve(payloads, id),
          archive,
          notices: notices[id],
          executables: executables[id] ?? [],
        })),
      };
      archives.set(asset, archive);
    }
    const metadata = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    parseSdkManifest(metadata, version);
    await rm(payloads, { recursive: true });
    // Publish the manifest last; an interrupted build is not a usable candidate.
    await writeFile(resolve(output, "sdk-release.json"), metadata, { flag: "wx" });
    return { manifest, metadata, archives, output };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}
