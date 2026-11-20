import assert from "node:assert/strict";
import { chmod, copyFile, lstat, mkdir } from "node:fs/promises";
import { dirname, posix, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { componentPath, validateComponentPaths } from "../sdk/component.mjs";
import { hostPlatform } from "../host-platform.mjs";
import { resolveComponent } from "./component-cache.mjs";

const defaultReleaseRoot = "https://github.com/ctxshift/bytorio/releases/download";
const supportedAuthoringProtocol = 1;
const reservedPlayerFiles = new Set([
  "game.png",
  "game.luau",
  "game.wasm",
  "console.json",
  "profile.json",
  "player-config.json",
]);

async function settledValues(pending) {
  const results = await Promise.allSettled(pending);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) {
    throw failure.reason;
  }
  return results.map((result) => result.value);
}

export function createReleasedSdk(release, options = {}) {
  const { manifest } = release;
  const host = options.host ?? hostPlatform().id;
  const root = (options.releaseRoot ?? defaultReleaseRoot).replace(/\/$/, "");
  const pending = new Map();
  async function component(id) {
    const descriptor = manifest.components[id];
    if (!descriptor) {
      throw new Error(`SDK ${manifest.version} is missing component ${id}`);
    }
    if (!pending.has(id)) {
      pending.set(
        id,
        resolveComponent(
          { id, descriptor, url: `${root}/sdk-v${manifest.version}/${descriptor.asset}` },
          options,
        ).finally(() => pending.delete(id)),
      );
    }
    return pending.get(id);
  }
  async function reference(ref, { directory = false, executable = false } = {}) {
    if (!ref) {
      throw new Error(`SDK ${manifest.version} is missing a required capability for ${host}`);
    }
    componentPath(ref.path);
    const installed = await component(ref.component);
    const file = installed.inventory.files.find((file) => file.path === ref.path);
    const info = directory
      ? installed.inventory.files.some((file) => file.path.startsWith(ref.path + "/"))
      : file;
    if (!info || (executable && file?.mode !== 0o755)) {
      throw new Error(
        `SDK ${manifest.version} has an invalid ${directory ? "directory" : "file"} entrypoint: ${ref.path}`,
      );
    }
    return resolve(installed.directory, ref.path);
  }
  function relativeAsset(path) {
    if (!path.startsWith("sdk/")) {
      throw new Error("SDK asset paths must use the sdk/ namespace");
    }
    const local = componentPath(path.slice(4));
    const base = posix.dirname(manifest.contract.path);
    return { component: manifest.contract.component, path: posix.join(base, local) };
  }
  return {
    defaults: manifest.defaults,
    reference,
    async asset(path) {
      if (path === "sdk/contract.json") {
        return reference(manifest.contract);
      }
      if (path === "sdk/templates/assets.json") {
        return reference(manifest.defaults.assets);
      }
      if (path.startsWith("sdk/luau/")) {
        const library = manifest.languages.luau?.libraries;
        if (!library) {
          throw new Error("SDK is missing Luau libraries");
        }
        return reference({
          component: library.component,
          path: posix.join(library.path, componentPath(path.slice("sdk/luau/".length))),
        });
      }
      return reference(relativeAsset(path));
    },
    library: (language) => reference(manifest.languages[language]?.libraries, { directory: true }),
    tool(language) {
      const tools = manifest.languages[language]?.hosts[host];
      return reference(tools?.[language === "luau" ? "analyzer" : "compiler"], {
        executable: true,
      });
    },
    async environment(language) {
      if (language !== "odin") {
        return {};
      }
      const tools = manifest.languages.odin?.hosts[host];
      const [compiler, linker] = await settledValues([
        reference(tools?.compiler, { executable: true }),
        reference(tools?.linker, { executable: true }),
      ]);
      // Odin uses its root on Windows and searches PATH for wasm-ld on macOS.
      // Neither lookup may select a globally installed toolchain.
      return { ODIN_ROOT: dirname(compiler), PATH: dirname(linker) };
    },
    async checking(language) {
      const [runtime, worker, executor] = await settledValues([
        reference(manifest.check.runtime),
        reference(manifest.check.workers[language]),
        language === "luau" ? reference(manifest.check.luauExecutor) : null,
      ]);
      return { runtime, worker, executor };
    },
    async player({ platform, target, luau }) {
      if (!["web", "native"].includes(platform)) {
        throw new Error("Player export platform must be web or native");
      }
      const refs = platform === "web" ? Object.values(manifest.web) : [manifest.native[host]];
      if (!refs.length || refs.some((ref) => !ref)) {
        throw new Error(
          `SDK ${manifest.version} does not include the requested ${platform} player for ${host}`,
        );
      }
      if (luau) {
        if (!manifest.check.luauExecutor) {
          throw new Error(`SDK ${manifest.version} does not include a Luau executor`);
        }
        refs.push(manifest.check.luauExecutor);
      }
      const ids = [...new Set(refs.map((ref) => ref.component))];
      const components = await settledValues(ids.map(component));
      const byId = new Map(ids.map((id, index) => [id, components[index]]));
      for (const ref of refs) {
        if (!byId.get(ref.component).inventory.files.some((file) => file.path === ref.path)) {
          throw new Error(`SDK player is missing entrypoint ${ref.path}`);
        }
      }
      const files = new Map();
      for (const installed of components) {
        for (const file of installed.inventory.files) {
          if (reservedPlayerFiles.has(file.path.toLowerCase())) {
            throw new Error(
              `SDK player payload conflicts with generated game output: ${file.path}`,
            );
          }
          const key = file.path.toLowerCase();
          const previous = files.get(key);
          if (
            previous &&
            (previous.path !== file.path ||
              previous.sha256 !== file.sha256 ||
              previous.mode !== file.mode)
          ) {
            throw new Error(`SDK player payloads contain conflicting files: ${file.path}`);
          }
          files.set(key, { ...file, source: resolve(installed.directory, file.path) });
        }
      }
      validateComponentPaths([...files.values()].map((file) => file.path));
      target = resolve(target);
      await mkdir(target, { recursive: true });
      if (!(await lstat(target)).isDirectory()) {
        throw new Error("Player export target must be a directory without a symlink");
      }
      for (const file of files.values()) {
        const path = file.path;
        const destination = resolve(target, componentPath(path));
        if (!destination.startsWith(target + sep)) {
          throw new Error("SDK player export path escapes its target");
        }
        let parent = target;
        for (const segment of path.split("/").slice(0, -1)) {
          parent = resolve(parent, segment);
          try {
            await mkdir(parent);
          } catch (error) {
            if (error.code !== "EEXIST") {
              throw error;
            }
          }
          if (!(await lstat(parent)).isDirectory()) {
            throw new Error("SDK player export parent must be a directory without a symlink");
          }
        }
        try {
          if (!(await lstat(destination)).isFile()) {
            throw new Error("SDK player export cannot overwrite links or special files");
          }
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw error;
          }
        }
        await copyFile(file.source, destination);
        await chmod(destination, file.mode);
      }
    },
  };
}

export async function loadReleasedAuthoring(release, options) {
  if (typeof options?.check !== "function") {
    throw new Error("SDK authoring requires a checking host adapter");
  }
  const sdk = createReleasedSdk(release, options);
  const modulePath = await sdk.reference(release.manifest.authoring);
  const authoring = await import(pathToFileURL(modulePath).href);
  if (
    authoring.authoringProtocol !== supportedAuthoringProtocol ||
    typeof authoring.createAuthoring !== "function"
  ) {
    throw new Error("Unsupported SDK authoring interface; a newer byt may be required");
  }
  assert.deepEqual(
    authoring.sdkContract?.profiles,
    release.manifest.profiles,
    "SDK authoring profiles differ from release metadata",
  );
  assert.deepEqual(
    authoring.sdkContract?.limits,
    release.manifest.limits,
    "SDK authoring limits differ from release metadata",
  );
  return authoring.createAuthoring({ sdk, check: options.check, log: options.log });
}
