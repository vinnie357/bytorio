import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createProject, buildProject } from "./sdk/project.mjs";

export async function build3dExamples(root = "build/compact-3d") {
  await mkdir(root, { recursive: true });
  const projects = [];
  for (const language of ["odin", "luau"]) {
    const project = resolve(root, language);
    try {
      await access(resolve(project, "console.json"));
    } catch {
      await createProject(project, language);
    }
    const manifest = JSON.parse(await readFile(resolve(project, "console.json")));
    Object.assign(manifest, {
      sdk: "0.3.0",
      profile: "compact-3d-preview-1",
      display: [320, 180],
      title: `Voxel Garden / ${language}`,
    });
    await writeFile(resolve(project, "console.json"), JSON.stringify(manifest, null, 2) + "\n");
    await copyFile(
      `tests/3d/cartridges/game.${language}`,
      resolve(project, `src/main.${language}`),
    );
    await buildProject(project);
    const configPath = resolve(project, "build/web/player-config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(
      configPath,
      JSON.stringify(
        { ...config, instructions: "Arrows: edit / stress / props / perspective · Space: 640×360" },
        null,
        2,
      ),
    );
    projects.push({ language, project });
  }
  await copyFile("tests/3d/player.html", resolve(root, "player.html"));
  return projects;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await build3dExamples();
}
