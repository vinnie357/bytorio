import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseSdkManifest } from "../cli/sdk-manifest.mjs";
import { packComponent, unpackComponent } from "./component.mjs";

// Extend canonical shared bytes with an independently qualified analyzer host.
export async function produceLuauHostSdk({ base, output, host, analyzer }) {
  const manifest = parseSdkManifest(await readFile(resolve(base, "sdk-release.json")));
  if (host !== "macos-x64") {
    throw new Error("Only Intel Mac uses the Luau-only candidate");
  }
  output = resolve(output);
  await mkdir(output);
  try {
    const staging = resolve(output, ".payload");
    await mkdir(staging);
    const executorId = manifest.check.luauExecutor.component;
    const descriptor = manifest.components[executorId];
    const executor = resolve(output, ".executor");
    await unpackComponent({
      archive: resolve(base, descriptor.asset),
      destination: executor,
      descriptor,
    });
    await mkdir(resolve(staging, "licenses"));
    await copyFile(resolve(executor, "licenses/luau.txt"), resolve(staging, "licenses/luau.txt"));
    await copyFile(analyzer, resolve(staging, basename(analyzer)));
    const id = `luau-${host}`;
    const asset = `bytorio-sdk-${manifest.version}-${id}.tar.gz`;
    const packed = await packComponent({
      root: staging,
      archive: resolve(output, asset),
      notices: ["licenses/luau.txt"],
      executables: [basename(analyzer)],
    });
    manifest.languages = {
      luau: {
        libraries: manifest.languages.luau.libraries,
        hosts: { [host]: { analyzer: { component: id, path: basename(analyzer) } } },
      },
    };
    manifest.starters = { luau: manifest.starters.luau };
    manifest.check.workers = { luau: manifest.check.workers.luau };
    manifest.native = {};
    const common = new Set(
      [
        manifest.authoring,
        manifest.contract,
        manifest.defaults.assets,
        manifest.check.runtime,
        manifest.check.workers.luau,
        manifest.check.luauExecutor,
        ...Object.values(manifest.web),
        manifest.languages.luau.libraries,
      ].map((ref) => ref.component),
    );
    for (const component of common) {
      await copyFile(
        resolve(base, manifest.components[component].asset),
        resolve(output, manifest.components[component].asset),
      );
    }
    manifest.components = Object.fromEntries(
      [...common].map((id) => [id, manifest.components[id]]),
    );
    manifest.components[id] = { asset, ...packed };
    const metadata = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    parseSdkManifest(metadata);
    await rm(staging, { recursive: true });
    await rm(executor, { recursive: true });
    await writeFile(resolve(output, "sdk-release.json"), metadata, { flag: "wx" });
    return { manifest, output };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}
