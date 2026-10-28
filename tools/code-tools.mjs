import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve, extname, relative } from "node:path";
import { commandTimeout, repo, run, tool } from "./toolchain.mjs";
const cppExtensions = [".cpp", ".cc", ".cxx", ".h", ".hpp", ".hh", ".hxx"];

function formatter(filename) {
  const extension = extname(filename);
  if (cppExtensions.includes(extension)) {
    return ["clang-format", ".clang-format"];
  }
  if (extension === ".odin") {
    return ["odinfmt", "odinfmt.json"];
  }
  if (extension === ".luau") {
    return ["stylua", "stylua.toml"];
  }
}

function formatOnce(source, filename) {
  if (cppExtensions.includes(extname(filename))) {
    return run(
      tool("clang-format"),
      ["--style=file", "--Werror", `--assume-filename=${resolve(repo, filename)}`],
      { input: source },
    );
  }
  if (extname(filename) === ".odin") {
    return run(tool("odinfmt"), ["-stdin", `-config:${resolve(repo, "odinfmt.json")}`], {
      input: source,
    });
  }
  if (extname(filename) === ".luau") {
    return run(
      tool("stylua"),
      [
        "--config-path",
        resolve(repo, "stylua.toml"),
        "--verify",
        "--stdin-filepath",
        filename,
        "-",
      ],
      { input: source },
    );
  }
  return source;
}
export function formatCacheKey(source, filename) {
  const selected = formatter(filename);
  if (!selected) {
    return;
  }
  const [name, config] = selected;
  const executable = resolve(tool(name));
  const { size, mtimeMs } = statSync(executable);
  return createHash("sha256")
    .update(
      JSON.stringify([
        executable,
        size,
        mtimeMs,
        readFileSync(resolve(repo, config), "utf8"),
        filename,
        source.replaceAll("\r\n", "\n"),
      ]),
    )
    .digest("hex");
}

function cached(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function stale(lock, graceMs = 5000) {
  const pid = Number(cached(resolve(lock, "pid")));
  if (pid > 0) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      return error.code === "ESRCH";
    }
    return false;
  }
  try {
    return Date.now() - statSync(lock).mtimeMs > graceMs;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return false;
  }
}

function takeOver(lock) {
  const gate = `${lock}.takeover`;
  try {
    mkdirSync(gate);
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
    if (stale(gate, 10000)) {
      rmSync(gate, { recursive: true, force: true });
    }
    return;
  }
  try {
    // Recheck under the gate so competing waiters cannot remove a new owner's lock.
    if (stale(lock)) {
      rmSync(lock, { recursive: true, force: true });
    }
  } finally {
    rmSync(gate, { recursive: true, force: true });
  }
}

export function formatSource(source, filename) {
  const key = formatCacheKey(source, filename);
  if (!key) {
    return source;
  }
  const folder = process.env.BYTORIO_FORMAT_CACHE || resolve(repo, "build/format-cache");
  mkdirSync(folder, { recursive: true });
  const entry = resolve(folder, key);
  const lock = `${entry}.lock`;
  const deadline = Date.now() + 6 * commandTimeout;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let owned = false;
  let temporary;
  try {
    while (true) {
      const hit = cached(entry);
      if (hit !== undefined) {
        return hit;
      }
      try {
        mkdirSync(lock);
        owned = true;
        writeFileSync(resolve(lock, "pid"), String(process.pid));
        break;
      } catch (error) {
        if (error.code !== "EEXIST" || owned) {
          throw error;
        }
      }
      if (Date.now() >= deadline) {
        break;
      }
      if (stale(lock)) {
        takeOver(lock);
      }
      Atomics.wait(pause, 0, 0, 25);
    }
    const hit = cached(entry);
    if (hit !== undefined) {
      return hit;
    }
    const result = convergeSource(source, filename);
    temporary = resolve(folder, `${key}.${randomUUID()}.tmp`);
    writeFileSync(temporary, result);
    renameSync(temporary, entry);
    return result;
  } finally {
    if (temporary) {
      rmSync(temporary, { force: true });
    }
    if (owned && cached(resolve(lock, "pid")) === String(process.pid)) {
      rmSync(lock, { recursive: true, force: true });
    }
  }
}

function convergeSource(source, filename) {
  // Long type annotations can need a second layout pass. Require a stable result
  // so generation and --check agree, and bound recovery for formatter regressions.
  let current = source.replaceAll("\r\n", "\n");
  const seen = new Set([current]);
  for (let pass = 0; pass < 6; pass++) {
    const next = formatOnce(current, filename);
    if (next === current) {
      return current;
    }
    if (seen.has(next)) {
      throw new Error(`Formatter layout cycle: ${filename}`);
    }
    seen.add(next);
    current = next;
  }
  throw new Error(`Formatter did not converge: ${filename}`);
}
export function sourceFiles(extension) {
  const extensions = Array.isArray(extension) ? extension : [extension];
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        [".git", ".tools", "build", "node_modules", ".bytorio", ".console"].includes(entry.name)
      ) {
        continue;
      }
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        visit(path);
      } else if (extensions.includes(extname(entry.name))) {
        files.push(relative(repo, path).replaceAll("\\", "/"));
      }
    }
  }
  visit(repo);
  return files.sort();
}
export const languageFiles = (language) =>
  sourceFiles(language === "cpp" ? cppExtensions : `.${language}`);
