import { readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

async function isStale(directory) {
  const owner = Number(await readFile(resolve(directory, "pid"), "utf8").catch(() => 0));
  return owner ? !alive(owner) : abandoned(directory);
}

// Two waiters can both judge one lock stale. If each deleted it, the slower one would delete the
// live lock that the faster one had just created. Takeovers therefore go through a short-lived gate
// folder, and the lock is judged again inside the gate. Waiters that lose the gate simply retry.
const gateStaleMs = 10000;
async function takeOver(directory) {
  const gate = `${directory}.takeover`;
  try {
    await mkdir(gate);
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
    // A gate left by a process that died inside it.
    const { mtimeMs } = await stat(gate).catch(() => ({ mtimeMs: Date.now() }));
    if (Date.now() - mtimeMs > gateStaleMs) {
      await rm(gate, { recursive: true, force: true });
    }
    return;
  }
  try {
    if (await isStale(directory)) {
      await rm(directory, { recursive: true, force: true });
    }
  } finally {
    await rm(gate, { recursive: true, force: true });
  }
}

// Release only a lock that still records this process, so a lock taken over from us is left alone.
function release(directory) {
  try {
    if (readFileSync(resolve(directory, "pid"), "utf8") === String(process.pid)) {
      rmSync(directory, { recursive: true, force: true });
    }
  } catch {
    // Already gone.
  }
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
      process.on("exit", () => release(directory));
      return;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
    if (await isStale(directory)) {
      await takeOver(directory);
    } else if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${directory}`);
    }
    await pause(200);
  }
}
