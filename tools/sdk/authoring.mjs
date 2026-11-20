import { readFile, writeFile, mkdir, readdir, copyFile, realpath, stat } from "node:fs/promises";
import { resolve, dirname, relative, sep } from "node:path";
import { timedSpawnSync as spawnSync } from "../command-timing.mjs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readGraphics } from "./assets.mjs";
import { bundleLuau, odinEntry, odinGraphics } from "./bundle.mjs";
import { inspectGuest } from "../../runtime/odin/web/policy.js";
import { encodeCartridge, encodeSaveIdentity } from "./cartridge.mjs";
import { decodeCartridge } from "../../runtime/odin/web/cartridge.js";
import { branding } from "../branding.mjs";
import { createScaffolder } from "./scaffold.mjs";
import contract from "../../sdk/contract.json" with { type: "json" };
import { normalizePlayerConfig } from "../../runtime/odin/web/player-config.js";

export const authoringProtocol = 1;
export const sdkContract = contract;
export function command(exe, args, options = {}) {
  const result = spawnSync(exe, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    timeout: 600000,
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${exe.split(/[\\/]/).at(-1)} failed (${result.status})`);
  }
  return result;
}
export async function files(root, extensions) {
  const found = [];
  async function visit(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (["build", "node_modules", ".git", ".bytorio", ".console"].includes(entry.name)) {
        continue;
      }
      const path = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error("Project source symlinks are not supported");
      }
      if (entry.isDirectory()) {
        await visit(path);
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        found.push(path);
      }
    }
  }
  await visit(root);
  return found;
}
async function inside(project, path) {
  if (
    typeof path !== "string" ||
    !path ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path)
  ) {
    throw new Error("Project paths must be relative and use forward slashes");
  }
  const result = await realpath(resolve(project, path));
  if (result !== project && !result.startsWith(project + sep)) {
    throw new Error("Project path escapes its directory");
  }
  return result;
}
export async function createAuthoring({ sdk, check, log = console.log }) {
  const selectedContract = JSON.parse(await readFile(await sdk.asset("sdk/contract.json"), "utf8"));
  assert.deepEqual(selectedContract, contract, "SDK authoring module and data contracts differ");
  const { syncEditor } = await createScaffolder({
    readAsset: async (path) => readFile(await sdk.asset(path), "utf8"),
    branding,
  });
  const defaults = sdk.defaults ?? {
    profile: contract.profile,
    display: contract.defaultDisplayMode,
  };
  async function manifest(path, value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Project configuration must be an object");
    }
    const project = await realpath(resolve(path));
    encodeSaveIdentity(value.save);
    const player = normalizePlayerConfig({
      title: value.title || branding.gameTitle,
      ...value.player,
    });
    const profile =
      value.sdk !== undefined
        ? contract.profiles.find((item) => item.sdk === value.sdk)
        : contract.profiles.find((item) => item.name === (value.profile ?? defaults.profile));
    if (!profile || (value.profile !== undefined && value.profile !== profile.name)) {
      throw new Error("Unsupported SDK or profile requirements");
    }
    const language = value.language ?? "luau";
    if (!["odin", "luau"].includes(language)) {
      throw new Error("language must be luau or odin");
    }
    const display = value.display ?? defaults.display;
    if (
      !contract.displayModes.some(
        ([w, h]) => display?.[0] === w && display?.[1] === h && display.length === 2,
      )
    ) {
      throw new Error("Unsupported display mode");
    }
    let entry = await inside(project, value.entry ?? `src/main.${language}`);
    if (language === "odin" && (await stat(entry)).isFile()) {
      if (!entry.endsWith(".odin")) {
        throw new Error("Odin entry must be an .odin file or package directory");
      }
      entry = dirname(entry);
    }
    return {
      ...value,
      player,
      sdk: profile.sdk,
      language,
      display,
      profile: profile.name,
      profileId: profile.id,
      project,
      entry,
      assets:
        value.assets !== undefined
          ? await inside(project, value.assets)
          : await sdk.asset("sdk/templates/assets.json"),
      cover: value.cover ? await inside(project, value.cover) : null,
    };
  }
  async function prepare(path, value, options = {}) {
    const spec = await manifest(path, value);
    const buildRoot = resolve(options.buildRoot ?? resolve(spec.project, "build"));
    if (buildRoot === spec.project || spec.project.startsWith(buildRoot + sep)) {
      throw new Error("Build output cannot be the project directory or its ancestor");
    }
    const { packet, palette } = await readGraphics(spec.assets);
    const generated = resolve(buildRoot, "generated");
    await mkdir(generated, { recursive: true });
    if (spec.language === "luau") {
      await syncEditor(spec.project);
      const sources = await files(spec.project, [".luau"]);
      command(await sdk.tool("luau"), ["--solver=new", ...sources], { cwd: spec.project });
      const source = await bundleLuau({
        entry: spec.entry,
        project: spec.project,
        sdkRoot: await sdk.library("luau"),
        assets: packet,
        display: spec.display,
        profile: spec.profileId,
      });
      await writeFile(resolve(generated, "game.luau"), source);
    } else {
      const sources = await files(spec.entry, [".odin"]);
      if (sources.length === 0) {
        throw new Error("No Odin sources found");
      }
      const list = new Set(sources.map((file) => relative(spec.entry, file).replaceAll("\\", "/")));
      if (
        list.has("bytorio_entry.odin") ||
        [...list].some((name) => name.startsWith("bytorio_assets/"))
      ) {
        throw new Error("Source uses a reserved SDK filename");
      }
      // Remove only stale compiler inputs previously generated inside this project's build folder.
      const { rm } = await import("node:fs/promises");
      const destination = resolve(generated, "odin");
      if (!destination.startsWith(buildRoot + sep)) {
        throw new Error("Invalid generated source directory");
      }
      await rm(destination, { recursive: true, force: true });
      await mkdir(destination, { recursive: true });
      for (const file of sources) {
        const target = resolve(destination, relative(spec.entry, file));
        await mkdir(dirname(target), { recursive: true });
        await copyFile(file, target);
      }
      await mkdir(resolve(destination, "bytorio_assets"));
      await writeFile(
        resolve(destination, "bytorio_assets/assets.odin"),
        odinGraphics({ packet, palette }),
      );
      await writeFile(
        resolve(destination, "bytorio_entry.odin"),
        odinEntry({
          graphicsImport: 'assets "./bytorio_assets"',
          display: spec.display[0] === 320 ? "Low" : "High",
        }),
      );
      const exe = await sdk.tool("odin");
      command(
        exe,
        [
          "build",
          destination,
          "-target:freestanding_wasm32",
          `-define:CONSOLE_PROFILE=${spec.profileId}`,
          "-no-entry-point",
          "-o:speed",
          "-source-code-locations:filename",
          `-collection:sdk=${await sdk.library("odin")}`,
          `-out:${resolve(generated, "game.wasm")}`,
          `-extra-linker-flags:--max-memory=${contract.limits.guestMemoryBytes}`,
        ],
        {
          cwd: spec.project,
          env: { ...process.env, ...(await sdk.environment?.("odin")) },
        },
      );
      const bytes = await readFile(resolve(generated, "game.wasm"));
      inspectGuest(bytes);
      const module = new WebAssembly.Module(bytes);
      for (const name of Object.keys(contract.requiredExports)) {
        if (
          !WebAssembly.Module.exports(module).some(
            (item) => item.name === name && item.kind === "function",
          )
        ) {
          throw new Error(`Missing SDK export: ${name}`);
        }
      }
    }
    return { ...spec, generated, buildRoot };
  }
  async function projectCartridge(spec, coverPath = spec.cover) {
    if (spec.content !== undefined && !Array.isArray(spec.content)) {
      throw new Error("content must be an array of { id, path } entries");
    }
    const content = [];
    const limits = contract.cartridge.content;
    if ((spec.content?.length || 0) > limits.maxEntries) {
      throw new Error("Cartridge content exceeds its entry limit");
    }
    let contentBytes = limits.headerBytes + (spec.content?.length || 0) * limits.recordBytes;
    for (const entry of spec.content || []) {
      const path = await inside(spec.project, entry.path);
      const info = await stat(path);
      contentBytes += info.size;
      if (!info.isFile() || contentBytes > limits.maxBytes) {
        throw new Error("Invalid content file or cartridge content exceeds its byte limit");
      }
      content.push({ id: entry.id, bytes: await readFile(path) });
    }
    return encodeCartridge({
      title: spec.title || branding.gameTitle,
      profile: spec.profile,
      language: spec.language,
      display: spec.display,
      code: await readFile(
        resolve(spec.generated, spec.language === "luau" ? "game.luau" : "game.wasm"),
      ),
      assets: JSON.parse(await readFile(spec.assets, "utf8")),
      cover: coverPath ? await readFile(coverPath) : null,
      content,
      save: spec.save,
    });
  }

  async function smoke(spec) {
    const luau = spec.language === "luau";
    const cartridge = await projectCartridge(spec);
    const cartridgePath = resolve(spec.generated, "check.png");
    await writeFile(cartridgePath, cartridge);
    await check({
      worker: spec.checking.worker,
      cartridge: cartridgePath,
      game: luau ? spec.checking.executor : resolve(spec.generated, "game.wasm"),
      source: luau ? resolve(spec.generated, "game.luau") : null,
      runtime: spec.checking.runtime,
    });
  }
  async function checkProject(path, value, options = {}) {
    const spec = await prepare(path, value, options);
    spec.checking = await sdk.checking(spec.language);
    await smoke(spec);
    log(`Checked ${spec.language} SDK ${spec.sdk}: types, assets, ABI and first frames.`);
    return spec;
  }
  async function buildProject(path, value, options) {
    if (
      !Array.isArray(options?.targets) ||
      options.targets.some((target) => !["web", "native"].includes(target)) ||
      new Set(options.targets).size !== options.targets.length
    ) {
      throw new Error("Choose explicit, unique web/native export targets");
    }
    const spec = await checkProject(path, value, options),
      luau = spec.language === "luau";
    const coverPath = options.cover ? resolve(options.cover) : spec.cover;
    const png = await projectCartridge(spec, coverPath);
    const cartridgeRevision = createHash("sha256").update(png).digest("hex");
    // Validate generated and user-provided covers with the actual player parser.
    const runtime = (
      await WebAssembly.instantiate(await readFile(spec.checking.runtime), {
        env: { sin: Math.sin },
      })
    ).instance.exports;
    decodeCartridge(runtime, png);
    await writeFile(resolve(spec.buildRoot, "game.png"), png);
    for (const platform of options.targets) {
      const target = resolve(spec.buildRoot, platform);
      await mkdir(resolve(target, "licenses"), { recursive: true });
      await writeFile(resolve(target, "game.png"), png);
      await writeFile(
        resolve(target, "profile.json"),
        JSON.stringify(
          {
            ...contract.profiles.find((item) => item.id === spec.profileId),
            containerVersion: contract.cartridge.containerVersion,
            maxPngBytes: contract.cartridge.maxPngBytes,
            schema: spec.profileId >= 2 ? "resource-protocol.json" : null,
          },
          null,
          2,
        ) + "\n",
      );
      if (spec.profileId >= 2) {
        await copyFile(
          await sdk.asset("sdk/resource-protocol.json"),
          resolve(target, "resource-protocol.json"),
        );
        const bundledProfile = JSON.parse(
          await readFile(await sdk.asset(`sdk/profiles/${spec.profile}.json`)),
        );
        // Runtime exports keep their schema local; documentation links belong to the SDK checkout.
        delete bundledProfile.specification;
        if (bundledProfile.performance) {
          delete bundledProfile.performance.measurements;
        }
        bundledProfile.packet.schema = "resource-protocol.json";
        await writeFile(
          resolve(target, `${spec.profile}.json`),
          JSON.stringify(bundledProfile, null, 2) + "\n",
        );
      }
      await sdk.player({ platform, target, luau });
      await copyFile(
        resolve(spec.generated, luau ? "game.luau" : "game.wasm"),
        resolve(target, luau ? "game.luau" : "game.wasm"),
      );
      await writeFile(
        resolve(target, "console.json"),
        JSON.stringify(
          {
            sdk: spec.sdk,
            language: spec.language,
            title: spec.title || branding.gameTitle,
            display: spec.display,
          },
          null,
          2,
        ) + "\n",
      );
      if (platform === "web") {
        await writeFile(
          resolve(target, "player-config.json"),
          JSON.stringify(
            { ...spec.player, cartridge: `./game.png?revision=${cartridgeRevision}` },
            null,
            2,
          ) + "\n",
        );
        const title = String(spec.title || branding.gameTitle)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;");
        for (const page of ["player.html", "debug.html"]) {
          const html = await readFile(resolve(target, page), "utf8");
          const titled = html.replace(/<title>.*?<\/title>/, () => `<title>${title}</title>`);
          await writeFile(
            resolve(target, page),
            page === "debug.html"
              ? titled.replace(
                  '<script type="module"',
                  `<script>globalThis.playerCartridge="./game.png?revision=${cartridgeRevision}"</script>\n<script type="module"`,
                )
              : titled,
          );
        }
      }
    }
    log(`Built ${spec.language}: ${relative(process.cwd(), spec.buildRoot)}`);
    return spec;
  }

  async function packProject(path, value, options = {}) {
    if (options.output && !/\.png$/i.test(options.output)) {
      throw new Error("Cartridge output must end in .png");
    }
    if (options.output && options.cover && resolve(options.output) === resolve(options.cover)) {
      throw new Error("Output cannot overwrite the cover image");
    }
    const spec = await buildProject(path, value, { targets: [], ...options });
    const source = resolve(spec.buildRoot, "game.png");
    const target = options.output ? resolve(options.output) : source;
    if (target !== source) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    log(`Packed cartridge: ${relative(process.cwd(), target)}`);
    return { ...spec, cartridge: target };
  }
  return {
    manifest,
    checkProject,
    buildProject,
    packProject,
    capabilities: { isolatedBuildRoot: true },
  };
}
