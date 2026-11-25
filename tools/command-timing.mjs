import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export function executableIs(path, name) {
  const basename = path.split(/[\\/]/).at(-1);
  const windowsExtension = /\.(?:exe|cmd|bat)$/i;
  const windowsStyle =
    path.includes("\\") || /^[a-z]:/i.test(path) || windowsExtension.test(basename);
  const executable = basename.replace(windowsExtension, "");
  return windowsStyle ? executable.toLowerCase() === name.toLowerCase() : executable === name;
}

// Opt-in synchronous command timings; stdout and stderr remain untouched.
export function timedSpawnSync(executable, args, options) {
  const started = Date.now();
  const result = spawnSync(executable, args, options);
  const destination = process.env.VALIDATION_COMMAND_TIMINGS;
  if (destination) {
    appendFileSync(
      destination,
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        executable,
        args,
        exitCode: result.status,
        error: result.error?.message ?? null,
      }) + "\n",
    );
  }
  return result;
}
