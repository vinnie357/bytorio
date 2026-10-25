import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { repo } from "./toolchain.mjs";

// Runs commands in the pinned x86_64 Linux image on Apple's `container` CLI (Rosetta). The
// checkout is mounted read-only and copied into the container's own /work, so Linux builds never
// touch the host's build/ directory. The container persists between runs to keep its tool installs.
const image = "bytorio-linux:ubuntu22.04-1";
const name = "bytorio-linux";
const [action, ...rest] = process.argv.slice(2);
const usage = "Usage: linux-container.mjs build | run <command...> | stop";

function container(args, { capture = false, check = true } = {}) {
  const result = spawnSync("container", args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (check && result.status !== 0) {
    throw new Error(`container ${args[0]} failed with status ${result.status}`);
  }
  return result;
}
function present(list, value) {
  return list.stdout.split("\n").some((line) => line.split(/\s+/).includes(value));
}
function build() {
  container([
    "build",
    "--platform",
    "linux/amd64",
    "-t",
    image,
    "-f",
    resolve(repo, "tools/linux/Dockerfile"),
    resolve(repo, "tools/linux"),
  ]);
}
function ensureRunning() {
  if (!present(container(["image", "list"], { capture: true }), image.split(":")[1])) {
    build();
  }
  const all = container(["list", "--all"], { capture: true });
  const running = container(["list"], { capture: true });
  if (present(all, name) && !present(running, name)) {
    container(["start", name]);
  } else if (!present(all, name)) {
    container([
      "run",
      "--detach",
      "--name",
      name,
      "--platform",
      "linux/amd64",
      "--rosetta",
      "--cpus",
      "4",
      "--memory",
      "8G",
      "--volume",
      `${repo}:/src:ro`,
      image,
      "sleep",
      "infinity",
    ]);
  }
}
function inContainer(command) {
  const script = [
    "set -e",
    // Cached build outputs stay in /work; everything else follows the checkout.
    "mkdir -p /work",
    "rsync -a --delete --exclude=/build --exclude=/node_modules --exclude=/.git /src/ /work/",
    "cd /work",
    // The validation runner fingerprints sources through git, so give /work a throwaway history.
    "git init -q 2>/dev/null || true",
    "git add -A",
    "git -c user.name=container -c user.email=container@localhost commit -q --allow-empty -m snapshot || true",
    "mise trust -q /work",
    // Tool shims put node, odin and the rest on PATH for plain commands.
    'export PATH="$HOME/.local/share/mise/shims:$PATH"',
    command,
  ].join("\n");
  return container(["exec", "--workdir", "/work", name, "bash", "-lc", script], { check: false });
}

if (action === "build") {
  build();
} else if (action === "run" && rest.length > 0) {
  ensureRunning();
  process.exitCode = inContainer(rest.join(" ")).status ?? 1;
} else if (action === "stop") {
  container(["stop", name], { check: false });
  container(["delete", name], { check: false });
} else {
  throw new Error(usage);
}
