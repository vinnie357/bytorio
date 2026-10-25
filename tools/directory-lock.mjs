import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// A lock folder holds a pid only after its owner wrote it. One without a pid is either being
// created right now or left by a process that died in between, so it counts as abandoned once it
// is a few seconds old.
const graceMs = 5000;
async function abandoned(directory) {
  const { mtimeMs } = await stat(directory).catch(() => ({ mtimeMs: Date.now() }));
  return Date.now() - mtimeMs > graceMs;
}

// Serializes scripts that share a build folder. `mkdir` is atomic, so exactly one caller creates
// the lock folder; the others wait, and a lock whose owner process is gone is taken over. The lock
// is released when the process exits, however it exits.
export async function acquireLock(directory, { timeoutMs = 600000 } = {}) {
  const started = Date.now();
  while (true) {
    try {
      await mkdir(directory);
      await writeFile(resolve(directory, "pid"), String(process.pid));
      process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
      return;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
    const owner = Number(await readFile(resolve(directory, "pid"), "utf8").catch(() => 0));
    if (owner ? !alive(owner) : await abandoned(directory)) {
      await rm(directory, { recursive: true, force: true });
    } else if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${directory}`);
    }
    await pause(200);
  }
}
