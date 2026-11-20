import assert from "node:assert/strict";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { mergeFaces, encodeScene, compressScene } from "./console-mesh.mjs";
import { createProject, buildProject } from "../../tools/sdk/project.mjs";
import { formatSource } from "../../tools/code-tools.mjs";
import { resourceSchema as schema } from "../../runtime/odin/web/constants.js";

const root = resolve("build/compact-3d/riverside");
await mkdir(root, { recursive: true });
const meshes = [];
for (const name of ["world", "rabbit"]) {
  meshes.push(mergeFaces(await readFile(`build/compact-3d/resolution/river/${name}.bin`)));
}
const live = JSON.parse(await readFile("build/compact-3d/resolution/river/live-scene.json"));
const walk = live.walk;
assert.equal(walk.heights.length, 157 * 137);
const bytes = Buffer.concat([
  encodeScene(...meshes),
  Buffer.from(walk.heights.map((height) => height + 1)),
]);
const compressed = compressScene(bytes);
const encoded = compressed.toString("base64");
const decodeUpdates = Math.floor(encoded.length / 16384) + Math.floor(bytes.length / 32768) + 1;
// The fixture must fit the published profile; never raise runtime limits here.
assert(meshes.flat().length * 2 <= schema.maxTrianglesPerCommit);
const geometry = {
  source: "experiments/voxel-resolution/river.mjs",
  worldQuads: meshes[0].length,
  rabbitQuads: meshes[1].length,
  triangles: meshes.flat().length * 2,
  encodedBytes: bytes.length,
  compressedBytes: compressed.length,
  facesPerUpload: 512,
  decodeUpdates,
  loadingUpdates: decodeUpdates + Math.ceil(meshes[0].length / 512) + 1,
  schemaVersion: schema.version,
  merge: "Adjacent coplanar unit faces with identical baked color and winding",
};
await writeFile(resolve(root, "geometry.json"), JSON.stringify(geometry, null, 2) + "\n");
for (const language of ["odin", "luau"]) {
  const project = resolve(root, language);
  try {
    await access(resolve(project, "console.json"));
  } catch {
    await createProject(project, language);
  }
  const manifestPath = resolve(project, "console.json");
  const manifest = JSON.parse(await readFile(manifestPath));
  Object.assign(manifest, {
    sdk: "0.3.0",
    profile: "compact-3d-preview-1",
    display: [320, 180],
    title: `Riverside / ${language}`,
  });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  let source = await readFile(`experiments/voxel-resolution/console-game.${language}`, "utf8");
  if (language === "odin") {
    await writeFile(resolve(project, "src/scene.bin"), bytes);
    // The SDK compiles copied sources in build/generated/odin. The fixture is
    // embedded at compile time and requires no filesystem access at runtime.
    source = source.replace("scene := []u8{}", 'scene := #load("../../../src/scene.bin")');
    source = source.replace("DECODE_UPDATES :: 0", `DECODE_UPDATES :: ${decodeUpdates}`);
  } else {
    await copyFile(
      "experiments/voxel-resolution/console-decode.luau",
      resolve(project, "src/console-decode.luau"),
    );
    source = source
      .replace(
        'local SCENE_ENCODED = ""',
        `local SCENE_ENCODED = "${compressed.toString("base64")}"`,
      )
      .replace("local SCENE_BYTES = 0", `local SCENE_BYTES = ${bytes.length}`);
  }
  await writeFile(
    resolve(project, `src/main.${language}`),
    formatSource(source, `main.${language}`),
  );
  await buildProject(project);
  const htmlPath = resolve(project, "build/web/debug.html");
  const html = await readFile(htmlPath, "utf8");
  await writeFile(
    htmlPath,
    html.replace(
      '<script type="module" src="./debug-player.js"></script>',
      '<script>globalThis.playerInstructions="WASD: walk · Q/E: rotate camera · Arrows: pan · R: reset · Space: 640×360 (hold)";</script>\n<script type="module" src="./debug-player.js"></script>',
    ),
  );
}
console.log(
  `Riverside cartridges: ${geometry.triangles} triangles; ${bytes.length} fixture bytes.`,
);
