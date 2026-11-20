import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { repo } from "./toolchain.mjs";
import { runStep, sourceState } from "./validation-runner.mjs";

const { values } = parseArgs({
  options: {
    label: { type: "string", default: new Date().toISOString().replaceAll(":", "-") },
    cases: { type: "string", default: "cold,warm,browser,unrelated-test,shared-runtime" },
    help: { type: "boolean", default: false },
  },
});
const changes = {
  browser: "runtime/odin/web/web-player.js",
  "unrelated-test": "tests/3d/renderer_test.odin",
  "shared-runtime": "runtime/odin/resources/resources.odin",
};
const tasks = ["build:odin", "deps:trace:resources", "deps:trace:graphics", "deps:trace:audio"];

async function measure(directory, name, force = false) {
  const commands = resolve(directory, `${name}.commands.jsonl`);
  writeFileSync(commands, "");
  const result = { name, startedAt: new Date().toISOString(), tasks: [] };
  const start = performance.now();
  try {
    for (const task of tasks) {
      console.log(`${name}: ${task}`);
      const log = `${name}-${task.replaceAll(":", "-")}.log`;
      const child = await runStep({
        executable: process.env.MISE_BIN || "mise",
        args: ["run", "--jobs", "1", ...(force ? ["--force"] : []), task],
        cwd: repo,
        log: resolve(directory, log),
        env: { ...process.env, VALIDATION_COMMAND_TIMINGS: commands },
        timeoutMs: 600000,
      });
      result.tasks.push({ task, log, ...child });
      if (child.exitCode !== 0) {
        throw new Error(`${task} failed; inspect ${log}: ${child.error || child.exitCode}`);
      }
    }
    return result;
  } finally {
    result.durationMs = Math.round(performance.now() - start);
    const entries = readFileSync(commands, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    result.compiles = entries
      .filter((entry) => /[\\/]odin(?:\.exe)?$/.test(entry.executable) && entry.args[0] === "build")
      .map((entry) => ({ source: entry.args[1], durationMs: entry.durationMs }));
    console.log(
      `${name}: ${(result.durationMs / 1000).toFixed(2)}s, ${result.compiles.length} Odin builds`,
    );
    writeFileSync(resolve(directory, `${name}.json`), JSON.stringify(result, null, 2) + "\n");
  }
}

async function main() {
  if (values.help) {
    console.log(
      "Usage: mise run bench:build-tasks -- --label NAME [--cases cold,warm,browser,unrelated-test,shared-runtime]",
    );
    console.log(
      "Run in an idle isolated checkout. Temporarily appends comments and restores original bytes/times.",
    );
    return;
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(values.label)) {
    throw new Error("Use a simple directory name for the measurement label");
  }
  const selected = values.cases.split(",");
  if (selected.some((name) => !["cold", "warm", ...Object.keys(changes)].includes(name))) {
    throw new Error("Unknown measurement case");
  }
  const directory = resolve(repo, "build/iteration-measurements", values.label);
  // Never overwrite another measurement series.
  mkdirSync(resolve(directory, ".."), { recursive: true });
  mkdirSync(directory);
  const report = {
    status: "running",
    source: sourceState(repo),
    node: process.version,
    platform: process.platform,
    cases: [],
  };
  try {
    for (const name of selected) {
      // Restoring a previous case's source can itself invalidate timestamp caches.
      // Prime the original inputs outside the timed edit before every warm case.
      if (name !== "cold") {
        await measure(directory, `${name}-prepare`);
      }
      const file = changes[name] && resolve(repo, changes[name]);
      const original = file && { bytes: readFileSync(file), stat: statSync(file) };
      try {
        if (file) {
          appendFileSync(file, "\n// Build invalidation measurement.\n");
        }
        report.cases.push(await measure(directory, name, name === "cold"));
      } finally {
        if (file) {
          writeFileSync(file, original.bytes);
          utimesSync(file, original.stat.atime, original.stat.mtime);
        }
      }
      writeFileSync(resolve(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
    }
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.message;
    throw error;
  } finally {
    report.finalSource = sourceState(repo);
    report.sourceChanged = report.finalSource.fingerprint !== report.source.fingerprint;
    if (report.sourceChanged && report.status === "passed") {
      report.status = "stale";
    }
    writeFileSync(resolve(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  }
  if (report.sourceChanged) {
    throw new Error("Source changed during measurement; results require investigation");
  }
}

await main();
