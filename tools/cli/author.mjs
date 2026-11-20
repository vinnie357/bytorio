import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { readGameProject, resolveGameProject } from "./project-config.mjs";
import { loadReleasedAuthoring } from "./released-sdk.mjs";
import { checkGame } from "../sdk/check.mjs";
import {
  assertCartridgeOutput,
  copyCartridge,
  createBuildStage,
  publishBuild,
  removeGenerated,
} from "./output.mjs";

function revision(project) {
  return createHash("sha256")
    .update(JSON.stringify({ config: project.config, pin: project.pin }))
    .digest("hex");
}

export async function authorGame(action, directory, options) {
  const target = options.target ?? "web";
  const targets =
    action === "pack" || action === "check" ? [] : target === "all" ? ["web", "native"] : [target];
  if (!["web", "native", "all"].includes(target)) {
    throw new Error("Target must be web, native or all");
  }
  if (options.output && !/\.png$/i.test(options.output)) {
    throw new Error("Cartridge output must end in .png");
  }
  const project = await resolveGameProject(directory, {
    ...options,
    target: targets.includes("native") ? "native" : "web",
  });
  const expected = revision(project);
  if (options.output) {
    await assertCartridgeOutput(project.directory, options.output);
  }
  const authoring = await loadReleasedAuthoring(project.release, {
    ...options,
    log: () => {},
    check: (payload) => checkGame(payload, { args: ["--sdk-check"] }),
  });
  if (!authoring.capabilities?.isolatedBuildRoot) {
    throw new Error("This SDK does not support isolated builds; select a newer SDK explicitly");
  }
  const stage = await createBuildStage(project.directory);
  let published = false;
  try {
    const settings = { targets, buildRoot: stage, cover: options.cover };
    const spec =
      action === "check"
        ? await authoring.checkProject(project.directory, project.config, settings)
        : action === "pack"
          ? await authoring.packProject(project.directory, project.config, settings)
          : await authoring.buildProject(project.directory, project.config, settings);
    if (spec.buildRoot !== stage) {
      throw new Error("SDK wrote outside the requested build staging directory");
    }
    if (revision(await readGameProject(project.directory)) !== expected) {
      throw new Error("Project configuration or SDK pin changed during the build; try again");
    }
    if (
      options.output &&
      [spec.cover, options.cover && resolve(options.cover)].includes(resolve(options.output))
    ) {
      throw new Error("Cartridge output cannot overwrite its cover image");
    }
    if (action === "check") {
      console.log(
        `Checked ${project.config.language} game with SDK ${project.release.manifest.version}.`,
      );
      return { ...project, spec };
    }
    const { buildRoot, preservedTargets } = await publishBuild(project.directory, stage);
    published = true;
    if (action === "pack") {
      const cartridge = await copyCartridge(
        resolve(buildRoot, "game.png"),
        options.output ?? resolve(buildRoot, "game.png"),
      );
      console.log(`Packed cartridge: ${relative(process.cwd(), cartridge)}`);
      reportPreserved(preservedTargets);
      return { ...project, spec, buildRoot, cartridge };
    }
    console.log(`Built ${targets.join(" and ")}: ${relative(process.cwd(), buildRoot)}`);
    reportPreserved(preservedTargets);
    return { ...project, spec, buildRoot };
  } finally {
    if (!published) {
      await removeGenerated(stage);
    }
  }
}

function reportPreserved(targets) {
  for (const target of targets) {
    console.log(`Kept ${target} export unchanged; run byt build --target ${target} to update it.`);
  }
}
