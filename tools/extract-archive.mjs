import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
// Written last, so a folder without it was interrupted or is still being written by another run.
const marker = ".extracted";

async function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}
async function complete(directory) {
  return exists(resolve(directory, marker));
}
// Moves an unmarked folder aside before deleting it. A concurrent run may have swapped in a
// finished folder since the caller looked, and deleting in place would destroy that winner.
async function retire(directory) {
  const aside = `${directory}.stale-${randomUUID()}`;
  try {
    await rename(directory, aside);
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (await complete(aside)) {
    await rename(aside, directory).catch(() => {});
  }
  await rm(aside, { recursive: true, force: true });
}

// Extracts a tarball whose single top-level folder is named like `directory`. The archive is
// unpacked beside the target and renamed into place after the marker is written, so `directory`
// either holds a complete tree or does not exist. A folder without the marker counts as absent.
// Concurrent callers all succeed: the loser of the rename keeps the winner's folder.
export async function extractArchive({ archive, directory }) {
  if (await complete(directory)) {
    return;
  }
  if (await exists(directory)) {
    await retire(directory);
  }
  const staging = `${directory}.tmp-${randomUUID()}`;
  try {
    await mkdir(staging, { recursive: true });
    await execute("tar", ["-xf", archive, "-C", staging]);
    const unpacked = resolve(staging, basename(directory));
    await writeFile(resolve(unpacked, marker), "");
    try {
      await rename(unpacked, directory);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) {
        throw error;
      }
      if (!(await complete(directory))) {
        await retire(directory);
        await rename(unpacked, directory);
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
