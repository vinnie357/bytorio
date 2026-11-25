import { readFileSync, rmSync } from "node:fs";
import * as defaultFs from "node:fs/promises";
import { resolve } from "node:path";

const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const mkdirContention = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY"]);

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
async function abandoned(directory, fs) {
  const { mtimeMs } = await fs.stat(directory).catch(() => ({ mtimeMs: Date.now() }));
  return Date.now() - mtimeMs > graceMs;
}

async function isStale(directory, fs) {
  const owner = Number(await fs.readFile(resolve(directory, "pid"), "utf8").catch(() => 0));
  return owner ? !alive(owner) : abandoned(directory, fs);
}

// Two waiters can both judge one lock stale. If each deleted it, the slower one would delete the
// live lock that the faster one had just created. Takeovers therefore go through a short-lived gate
// folder, and the lock is judged again inside the gate. Waiters that lose the gate simply retry.
const gateStaleMs = 10000;
async function takeOver(directory, fs) {
  const gate = `${directory}.takeover`;
  try {
    await fs.mkdir(gate);
  } catch (error) {
    if (!mkdirContention.has(error.code)) {
      throw error;
    }
    // Windows can report a sharing error while another waiter finishes deleting the gate.
    if (error.code !== "EEXIST") {
      return;
    }
    // A gate left by a process that died inside it.
    const { mtimeMs } = await fs.stat(gate).catch(() => ({ mtimeMs: Date.now() }));
    if (Date.now() - mtimeMs > gateStaleMs) {
      await fs.rm(gate, { recursive: true, force: true });
    }
    return;
  }
  try {
    if (await isStale(directory, fs)) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(gate, { recursive: true, force: true });
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
export async function acquireLock(directory, { timeoutMs = 600000, fs = defaultFs } = {}) {
  const started = Date.now();
  while (true) {
    let created = false;
    try {
      await fs.mkdir(directory);
      created = true;
    } catch (error) {
      if (!mkdirContention.has(error.code)) {
        throw error;
      }
    }
    if (created) {
      await fs.writeFile(resolve(directory, "pid"), String(process.pid));
      process.on("exit", () => release(directory));
      return;
    }
    if (await isStale(directory, fs)) {
      await takeOver(directory, fs);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${directory}`);
    }
    await pause(200);
  }
}
