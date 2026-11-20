import { readFile } from "node:fs/promises";
import { unpackComponent } from "../sdk/component.mjs";
import { resolveComponent } from "./component-cache.mjs";
import { parseSdkManifest, sdkCompatibility } from "./sdk-manifest.mjs";
import { resolveSdkRelease, selectSdkRelease } from "./sdk-registry.mjs";

try {
  const request = JSON.parse(await readFile(process.argv[2], "utf8"));
  if (["select-sdk", "resolve-sdk"].includes(request.operation)) {
    const release =
      request.operation === "select-sdk"
        ? await selectSdkRelease(request.requirements, request.options)
        : await resolveSdkRelease(request.version, request.options);
    console.log(JSON.stringify({ version: release.manifest.version, sha256: release.sha256 }));
    process.exit(0);
  }
  if (request.operation === "manifest") {
    const manifest = parseSdkManifest(
      Buffer.from(JSON.stringify(request.manifest)),
      request.version,
    );
    const incompatible = sdkCompatibility(manifest, request.requirements);
    if (incompatible) {
      throw new Error(incompatible);
    }
    console.log(JSON.stringify({ version: manifest.version, profile: manifest.defaults.profile }));
    process.exit(0);
  }
  const result =
    request.operation === "resolve"
      ? await resolveComponent(request.component, request.options)
      : { inventory: await unpackComponent(request) };
  console.log(
    JSON.stringify({
      files: result.inventory.files.length,
      notices: result.inventory.notices,
      ...(result.directory ? { directory: result.directory } : {}),
    }),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
