import { readdirSync } from "node:fs";
import { resolve, extname, relative } from "node:path";
import { repo, run, tool } from "./toolchain.mjs";
const cppExtensions = [".cpp", ".cc", ".cxx", ".h", ".hpp", ".hh", ".hxx"];
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
  throw new Error("not implemented");
}

export function formatSource(source, filename) {
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
