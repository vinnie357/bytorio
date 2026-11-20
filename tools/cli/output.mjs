import { constants } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const marker = ".bytorio-output.json";
const playerTargets = ["web", "native"];
const publicationTimeoutMs = 5000;
const publicationRetryMs = 25;

// New output directories do not exist yet. Resolve their nearest existing
// ancestor so filesystem aliases cannot hide a destination inside an export.
async function canonicalDestination(path) {
  path = resolve(path);
  const suffix = [];
  while (true) {
    try {
      return resolve(await realpath(path), ...suffix);
    } catch (error) {
      const parent = dirname(path);
      if (error.code !== "ENOENT" || parent === path) {
        throw error;
      }
      suffix.unshift(basename(path));
      path = parent;
    }
  }
}

export async function assertCartridgeOutput(project, output) {
  project = await realpath(project);
  const paths = [resolve(output), await canonicalDestination(output)];
  for (const target of playerTargets) {
    const exportRoot = resolve(project, "build", target);
    for (const destination of paths) {
      const path = relative(exportRoot, destination);
      if (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path)) {
        throw new Error(
          "Cartridge output cannot overwrite a player export; choose dist/game.png instead",
        );
      }
    }
  }
}

async function publicationLock(parent) {
  const path = resolve(parent, "publish.lock");
  const deadline = Date.now() + publicationTimeoutMs;
  while (true) {
    try {
      const file = await open(path, "wx");
      return async () => {
        await file.close();
        await rm(path);
      };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      const info = await lstat(path).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
        return null;
      });
      if (info && !info.isFile()) {
        throw new Error("Build publication lock cannot be a link or special file", {
          cause: error,
        });
      }
      if (Date.now() >= deadline) {
        throw new Error(
          "Another byt command is publishing this project; wait and retry. If no byt commands are running, remove .bytorio/staging/publish.lock and retry.",
          { cause: error },
        );
      }
      await delay(publicationRetryMs);
    }
  }
}

async function directoryExists(path) {
  try {
    if (!(await lstat(path)).isDirectory()) {
      throw new Error("Player exports cannot contain links or special files");
    }
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// Export files never alias the SDK cache. Hard links retain complete immutable
// snapshots without copying large cartridges when another target is published.
async function linkExport(source, destination) {
  if (!(await lstat(source)).isDirectory()) {
    throw new Error("Player exports cannot contain links or special files");
  }
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const input = resolve(source, entry.name);
    const output = resolve(destination, entry.name);
    if (entry.isDirectory()) {
      await mkdir(output);
      await linkExport(input, output);
    } else if (entry.isFile()) {
      await link(input, output);
    } else {
      throw new Error("Player exports cannot contain links or special files");
    }
  }
}

export async function projectDirectory(project, ...segments) {
  let path = project;
  for (const segment of segments) {
    path = resolve(path, segment);
    if (!path.startsWith(project + sep)) {
      throw new Error("Generated output escapes its project");
    }
    try {
      await mkdir(path);
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
    if (!(await lstat(path)).isDirectory()) {
      throw new Error("Generated output directories cannot be links or special files");
    }
  }
  return path;
}

export async function createBuildStage(project) {
  const parent = await projectDirectory(project, ".bytorio", "staging");
  const ignorePath = resolve(project, ".gitignore");
  let ignore = "";
  try {
    if (!(await lstat(ignorePath)).isFile()) {
      throw new Error("Generated ignore settings cannot overwrite a link or special file");
    }
    ignore = await readFile(ignorePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  const missing = ["build/", ".bytorio/"].filter((line) => !ignore.split(/\r?\n/).includes(line));
  if (missing.length) {
    await writeFile(
      ignorePath,
      ignore + (ignore && !ignore.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n",
    );
  }
  return mkdtemp(resolve(parent, "build-"));
}

export async function removeGenerated(path) {
  await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

async function ownedBuild(path) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (!info.isDirectory()) {
    throw new Error("Build output cannot replace a file or symlink");
  }
  try {
    const location = resolve(path, marker);
    const file = await lstat(location);
    if (!file.isFile() || file.size > 1024) {
      throw new Error("Invalid build ownership record");
    }
    const owner = JSON.parse(await readFile(location, "utf8"));
    if (owner.schema !== 1 || owner.generatedBy !== "byt") {
      throw new Error("Invalid build ownership record");
    }
  } catch (error) {
    throw new Error("Existing build directory is not owned by byt; move it before building", {
      cause: error,
    });
  }
  return true;
}

export async function publishBuild(project, stage) {
  const parent = resolve(project, ".bytorio/staging");
  stage = resolve(stage);
  if (dirname(stage) !== parent || !(await lstat(stage)).isDirectory()) {
    throw new Error("Only an owned staged build can be published");
  }
  const unlock = await publicationLock(parent);
  try {
    await writeFile(
      resolve(stage, marker),
      JSON.stringify({ schema: 1, generatedBy: "byt" }) + "\n",
      { flag: "wx" },
    );
    const destination = resolve(project, "build");
    const exists = await ownedBuild(destination);
    const preservedTargets = [];
    if (exists) {
      for (const target of playerTargets) {
        if (await directoryExists(resolve(stage, target))) {
          continue;
        }
        if (!(await directoryExists(resolve(destination, target)))) {
          continue;
        }
        await mkdir(resolve(stage, target));
        await linkExport(resolve(destination, target), resolve(stage, target));
        preservedTargets.push(target);
      }
    }
    const previous = exists ? await mkdtemp(resolve(parent, "previous-")) : null;
    let moved = false;
    try {
      if (previous) {
        await rename(destination, resolve(previous, "build"));
        moved = true;
      }
      await rename(stage, destination);
    } catch (error) {
      if (moved) {
        await rename(resolve(previous, "build"), destination);
        moved = false;
      }
      if (previous && !moved) {
        await removeGenerated(previous);
      }
      throw error;
    }
    if (previous) {
      await removeGenerated(previous);
    }
    return { buildRoot: destination, preservedTargets };
  } finally {
    await unlock();
  }
}

export async function copyCartridge(source, output) {
  output = resolve(output);
  if (output === resolve(source)) {
    return output;
  }
  await mkdir(dirname(output), { recursive: true });
  try {
    if (!(await lstat(output)).isFile()) {
      throw new Error("Cartridge output cannot replace a link or special file");
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  const temporary = resolve(dirname(output), `.byt-cartridge-${randomUUID()}.tmp`);
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  return output;
}

// Immutable session snapshots survive another build replacing the public output.
// Hard links reuse cartridge bytes without connecting anything to the SDK cache.
export async function snapshotWeb(project, source) {
  const parent = await projectDirectory(project, ".bytorio", "sessions");
  const destination = await mkdtemp(resolve(parent, "web-"));
  try {
    await linkExport(source, destination);
    return destination;
  } catch (error) {
    await removeGenerated(destination);
    throw error;
  }
}
