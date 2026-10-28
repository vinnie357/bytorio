import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const temporaryPrefix = ".tmp-";

export const isTemporary = (path) => basename(path).startsWith(temporaryPrefix);

// A path with `path`'s own name inside a folder unique to this call, beside it, for output that is written first and
// renamed into place. Several processes can then build the same artifact without sharing an intermediate file (the
// folder holds whatever a tool derives from the name, such as Odin's `<name>.o`), a reader opening `path` sees the old
// complete file or the new complete one, and the file keeps the name it would have had, so nothing that embeds the
// name differs between builds.
export async function temporaryBeside(path) {
  const folder = resolve(dirname(path), `${temporaryPrefix}${randomUUID().slice(0, 8)}`);
  await mkdir(folder, { recursive: true });
  return resolve(folder, basename(path));
}

// Removes the folder `temporaryBeside` made, and what is left in it.
export const discardTemporary = (temporary) =>
  rm(dirname(temporary), { force: true, recursive: true });

// Replaces `destination` with a copy of `source` in one rename.
export async function copyAtomic(source, destination) {
  const temporary = await temporaryBeside(destination);
  try {
    await copyFile(source, temporary);
    await rename(temporary, destination);
  } finally {
    await discardTemporary(temporary);
  }
}
