import { copyFile, mkdir, rename as fsRename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

const temporaryPrefix = ".tmp-";
const retryableRenameErrors = new Set(["EPERM", "EACCES", "EBUSY"]);
const maximumRenameDelayMs = 100;
const maximumRenameWaitMs = 2000;

// Windows readers briefly block replacement; cap retry waits at two seconds.
export async function renameReplacing(
  from,
  to,
  { rename = fsRename, attempts = 20, delayMs = 25 } = {},
) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new RangeError("Rename attempts must be a positive safe integer.");
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError("Rename delay must be a non-negative finite number.");
  }
  let remainingWaitMs = maximumRenameWaitMs;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await rename(from, to);
    } catch (error) {
      if (!retryableRenameErrors.has(error?.code) || attempt + 1 === attempts) {
        throw error;
      }
      const delay = Math.min(delayMs * (attempt + 1), maximumRenameDelayMs, remainingWaitMs);
      remainingWaitMs -= delay;
      if (delay > 0) {
        await wait(delay);
      }
    }
  }
}

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
export async function copyAtomic(source, destination, { rename } = {}) {
  const temporary = await temporaryBeside(destination);
  try {
    await copyFile(source, temporary);
    await renameReplacing(temporary, destination, { rename });
  } finally {
    await discardTemporary(temporary);
  }
}
