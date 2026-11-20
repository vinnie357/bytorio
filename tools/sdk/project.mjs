import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { timedSpawnSync as spawnSync } from "../command-timing.mjs";
import { createAuthoring } from "./authoring.mjs";
import { checkGame } from "./check.mjs";
import { createScaffolder } from "./scaffold.mjs";
import { exportPlayer } from "../player-export.mjs";
import { tool, task } from "../toolchain.mjs";
import { branding } from "../branding.mjs";
import { requireNativeHost, nativeHostNote } from "../host-platform.mjs";

export { command, files } from "./authoring.mjs";
export { requireNativeHost as requireNativePlayer, nativeHostNote };
export const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const sdk = {
  asset: (path) => resolve(repo, path),
  library: (language) => resolve(repo, "sdk", language),
  async tool(language) {
    const executable = tool(language === "luau" ? "luau-analyze" : "odin");
    if (language === "odin") {
      const version = spawnSync(executable, ["version"], { encoding: "utf8" });
      if (!version.stdout?.includes("84bc3fc")) {
        throw new Error("Odin dev-2026-10 (84bc3fc) is required");
      }
    }
    return executable;
  },
  async checking(language) {
    task("build:odin");
    if (language === "luau") {
      task("deps:luau");
    }
    return {
      worker: fileURLToPath(new URL("./smoke-worker.mjs", import.meta.url)),
      runtime: resolve(repo, "build/odin-player/web/runtime.wasm"),
      executor:
        language === "luau" ? resolve(repo, "build/luau-executor/luau-executor.wasm") : null,
    };
  },
  player: ({ platform, target, luau }) =>
    exportPlayer({
      platform,
      target,
      luau,
      source: resolve(repo, "build/odin-player", platform),
    }),
};
const authoring = await createAuthoring({ sdk, check: checkGame });
const config = async (path) => JSON.parse(await readFile(resolve(path, "console.json"), "utf8"));

export const { createProject, syncEditor } = await createScaffolder({
  readAsset: (path) => readFile(sdk.asset(path), "utf8"),
  branding,
});

export async function manifest(path) {
  return authoring.manifest(path, await config(path));
}

export async function checkProject(path) {
  requireNativeHost();
  return authoring.checkProject(path, await config(path));
}

export async function buildProject(path, options = {}) {
  requireNativeHost();
  return authoring.buildProject(path, await config(path), {
    targets: ["web", "native"],
    ...options,
  });
}

export async function packProject(path, options = {}) {
  requireNativeHost();
  return authoring.packProject(path, await config(path), {
    targets: ["web", "native"],
    ...options,
  });
}
