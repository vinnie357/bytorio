import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cliPlatforms } from "../host-platform.mjs";
import { parseSdkManifest } from "../cli/sdk-manifest.mjs";
import { unpackComponent } from "./component.mjs";

function commonReferences(manifest) {
  return [
    manifest.authoring,
    manifest.contract,
    manifest.defaults.assets,
    manifest.check.runtime,
    ...Object.values(manifest.check.workers),
    ...(manifest.check.luauExecutor ? [manifest.check.luauExecutor] : []),
    ...Object.values(manifest.web),
    ...Object.values(manifest.languages).map((language) => language.libraries),
  ];
}

function entrypoints(manifest) {
  const libraries = new Set(Object.values(manifest.languages).map((item) => item.libraries));
  const entries = commonReferences(manifest).map((ref) => ({
    ref,
    directory: libraries.has(ref),
  }));
  for (const language of Object.values(manifest.languages)) {
    for (const tools of Object.values(language.hosts)) {
      for (const [name, ref] of Object.entries(tools)) {
        entries.push({ ref, executable: ["analyzer", "compiler", "linker"].includes(name) });
      }
    }
  }
  entries.push(...Object.values(manifest.native).map((ref) => ({ ref, executable: true })));
  return entries;
}

export function verifySdkEntrypoints(manifest, inventories) {
  for (const { ref, directory, executable } of entrypoints(manifest)) {
    const files = inventories.get(ref.component).files;
    const file = files.find((file) => file.path === ref.path);
    if (
      (directory ? !files.some((file) => file.path.startsWith(ref.path + "/")) : !file) ||
      (executable && file?.mode !== 0o755)
    ) {
      throw new Error(`SDK entrypoint is missing or has the wrong mode: ${ref.path}`);
    }
  }
}

export async function assembleSdk({ candidates, canonicalHost, output }) {
  if (!Array.isArray(candidates) || !candidates.length || !output) {
    throw new Error("SDK assembly requires host candidates and a new output directory");
  }
  const byHost = new Map();
  for (const candidate of candidates) {
    if (!cliPlatforms.includes(candidate.host) || byHost.has(candidate.host)) {
      throw new Error("SDK candidates must have distinct supported hosts");
    }
    const directory = resolve(candidate.directory);
    const manifest = parseSdkManifest(await readFile(resolve(directory, "sdk-release.json")));
    for (const language of Object.values(manifest.languages)) {
      if (Object.keys(language.hosts).some((host) => host !== candidate.host)) {
        throw new Error("SDK candidate claims tools for another host");
      }
    }
    if (Object.keys(manifest.native).some((host) => host !== candidate.host)) {
      throw new Error("SDK candidate claims a player for another host");
    }
    byHost.set(candidate.host, { directory, manifest });
  }
  const canonical = byHost.get(canonicalHost);
  if (!canonical) {
    throw new Error("The canonical SDK host must be one of the candidates");
  }
  const manifest = structuredClone(canonical.manifest);
  const commonIds = new Set(commonReferences(manifest).map((ref) => ref.component));
  const selected = new Map();
  const assets = new Map();
  function select(id, candidate) {
    const descriptor = candidate.manifest.components[id];
    const previous = selected.get(id);
    if (previous) {
      assert.deepEqual(previous.descriptor, descriptor, `Conflicting SDK component ${id}`);
      return;
    }
    if (assets.has(descriptor.asset)) {
      throw new Error(`SDK component asset name is not unique: ${descriptor.asset}`);
    }
    selected.set(id, { descriptor, archive: resolve(candidate.directory, descriptor.asset) });
    assets.set(descriptor.asset, id);
  }
  for (const id of commonIds) {
    select(id, canonical);
  }
  manifest.native = {};
  for (const language of Object.values(manifest.languages)) {
    language.hosts = {};
  }
  for (const [host, candidate] of byHost) {
    const input = candidate.manifest;
    for (const field of [
      "schema",
      "version",
      "cliProtocol",
      "cliVersionRange",
      "profiles",
      "limits",
      "defaults",
      "authoring",
      "contract",
      "web",
    ]) {
      assert.deepEqual(
        input[field],
        canonical.manifest[field],
        `SDK candidates differ in ${field}`,
      );
    }
    assert.deepEqual(input.check.runtime, manifest.check.runtime, "SDK check runtime differs");
    if (input.languages.luau) {
      assert.deepEqual(
        input.check.luauExecutor,
        manifest.check.luauExecutor,
        "SDK executor differs",
      );
    }
    const references = [];
    for (const [name, language] of Object.entries(input.languages)) {
      if (!manifest.languages[name]) {
        throw new Error(`Canonical SDK does not define ${name}`);
      }
      assert.deepEqual(
        language.libraries,
        manifest.languages[name].libraries,
        "SDK libraries differ",
      );
      assert.deepEqual(input.starters[name], manifest.starters[name], "SDK starter differs");
      assert.deepEqual(
        input.check.workers[name],
        manifest.check.workers[name],
        "SDK checker differs",
      );
      manifest.languages[name].hosts[host] = language.hosts[host];
      references.push(...Object.values(language.hosts[host]));
    }
    if (input.native[host]) {
      manifest.native[host] = input.native[host];
      references.push(input.native[host]);
    }
    for (const ref of references) {
      if (commonIds.has(ref.component)) {
        throw new Error("Host tools and native players must use separate SDK components");
      }
      select(ref.component, candidate);
    }
  }
  manifest.components = Object.fromEntries(
    [...selected].map(([id, value]) => [id, value.descriptor]),
  );
  const metadata = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  parseSdkManifest(metadata, manifest.version);
  output = resolve(output);
  await mkdir(output);
  try {
    const verification = resolve(output, ".verification");
    await mkdir(verification);
    const inventories = new Map();
    for (const [id, value] of selected) {
      const archive = resolve(output, value.descriptor.asset);
      await copyFile(value.archive, archive);
      const destination = resolve(verification, id);
      inventories.set(
        id,
        await unpackComponent({ archive, destination, descriptor: value.descriptor }),
      );
      await rm(destination, { recursive: true });
    }
    verifySdkEntrypoints(manifest, inventories);
    await rm(verification, { recursive: true });
    await writeFile(resolve(output, "sdk-release.json"), metadata, { flag: "wx" });
    return { manifest, metadata, output };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}
