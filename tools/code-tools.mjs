import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { resolve, extname, relative } from "node:path";
import { commandTimeout, repo, run, tool } from "./toolchain.mjs";
const cppExtensions = [".cpp", ".cc", ".cxx", ".h", ".hpp", ".hh", ".hxx"];
const formatterHashes = new Map();

function formatter(filename) {
  const extension = extname(filename);
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
  if (!formatterHashes.has(executable)) {
    formatterHashes.set(
      executable,
      createHash("sha256").update(readFileSync(executable)).digest("hex"),
    );
  }
  return createHash("sha256")
    .update(
      JSON.stringify([
        executable,
        formatterHashes.get(executable),
        readFileSync(resolve(repo, config), "utf8"),
        filename,
        source.replaceAll("\r\n", "\n"),
      ]),
    )
    .digest("hex");
}

function cached(path, refresh = false) {
  try {
    const contents = readFileSync(path, "utf8");
    if (refresh) {
      const now = new Date();
      try {
        utimesSync(path, now, now);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
    return contents;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function stale(lock) {
  const pid = Number(cached(resolve(lock, "pid")));
  if (pid > 0) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      return error.code === "ESRCH";
    }
    return false;
  }
  return true;
}

function pruneCache(folder) {
  const now = Date.now();
  for (const name of readdirSync(folder)) {
    const age = /^[a-f0-9]{64}$/.test(name)
      ? 7 * 24 * 60 * 60 * 1000
      : name.endsWith(".tmp")
        ? 60 * 60 * 1000
        : undefined;
    if (age === undefined) {
      continue;
    }
    const path = resolve(folder, name);
    try {
      if (now - statSync(path).mtimeMs > age) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

export function formatSource(source, filename) {
  const key = formatCacheKey(source, filename);
  if (!key) {
    return cppExtensions.includes(extname(filename)) ? convergeSource(source, filename) : source;
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
      const hit = cached(entry, true);
      if (hit !== undefined) {
        return hit;
      }
      const candidate = `${lock}.${randomUUID()}.tmp`;
      mkdirSync(candidate);
      try {
        writeFileSync(resolve(candidate, "pid"), String(process.pid));
        try {
          renameSync(candidate, lock);
          owned = true;
          break;
        } catch (error) {
          if (!["ENOTEMPTY", "EEXIST", "EPERM"].includes(error.code)) {
            throw error;
          }
        }
      } finally {
        rmSync(candidate, { recursive: true, force: true });
      }
      if (Date.now() >= deadline) {
        break;
      }
      if (stale(lock)) {
        // Locks avoid duplicate work; racing formatters atomically publish identical bytes.
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      Atomics.wait(pause, 0, 0, 25);
    }
    const hit = cached(entry, true);
    if (hit !== undefined) {
      return hit;
    }
    const result = convergeSource(source, filename);
    temporary = resolve(folder, `${key}.${randomUUID()}.tmp`);
    writeFileSync(temporary, result);
    renameSync(temporary, entry);
    pruneCache(folder);
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
