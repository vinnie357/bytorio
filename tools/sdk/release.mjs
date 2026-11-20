import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseSdkManifest } from "../cli/sdk-manifest.mjs";
import { unpackComponent } from "./component.mjs";
import { verifySdkEntrypoints } from "./assemble.mjs";

export async function verifySdkRelease(directory, version) {
  const manifest = parseSdkManifest(
    await readFile(resolve(directory, "sdk-release.json")),
    version,
  );
  for (const host of ["windows-x64", "macos-arm64", "macos-x64"]) {
    if (!manifest.languages.luau?.hosts[host]) {
      throw new Error(`Release is missing Luau on ${host}`);
    }
    if (host !== "macos-x64" && (!manifest.languages.odin?.hosts[host] || !manifest.native[host])) {
      throw new Error(`Release is missing Odin/native on ${host}`);
    }
  }
  const temporary = await mkdtemp(resolve(tmpdir(), "byt-sdk-release-"));
  const inventories = new Map();
  try {
    for (const [id, descriptor] of Object.entries(manifest.components)) {
      const destination = resolve(temporary, id);
      inventories.set(
        id,
        await unpackComponent({
          archive: resolve(directory, descriptor.asset),
          destination,
          descriptor,
        }),
      );
      await rm(destination, { recursive: true });
    }
    verifySdkEntrypoints(manifest, inventories);
    return manifest;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
