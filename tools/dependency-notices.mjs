import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { repo } from "./toolchain.mjs";

export async function dependencyNotices() {
  const lock = JSON.parse(await readFile(resolve(repo, "package-lock.json"), "utf8"));
  const notices = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path || entry.dev) {
      continue;
    }
    const root = resolve(repo, path);
    const files = (await readdir(root))
      .filter((name) => /^(licen[cs]e|notice|copying)(\.|$)/i.test(name))
      .sort();
    if (!files.length) {
      throw new Error(`Missing dependency license: ${path}`);
    }
    notices.push(
      `${path.replace(/^node_modules\//, "")} ${entry.version}\n${await Promise.all(files.map((file) => readFile(resolve(root, file), "utf8"))).then((texts) => texts.join("\n"))}`,
    );
  }
  return notices.join("\n\n----------------------------------------\n\n") + "\n";
}
