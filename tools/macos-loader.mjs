import assert from "node:assert/strict";

export function verifyMacLoaderPaths(output, checkout) {
  const commands = new Set([
    "LC_RPATH",
    "LC_ID_DYLIB",
    "LC_LOAD_DYLIB",
    "LC_LOAD_WEAK_DYLIB",
    "LC_REEXPORT_DYLIB",
    "LC_LOAD_UPWARD_DYLIB",
    "LC_LAZY_LOAD_DYLIB",
  ]);
  const paths = [];
  let command;
  for (const line of output.split(/\r?\n/)) {
    const text = line.trim();
    if (text.startsWith("cmd ")) {
      command = text.slice(4);
    } else if (commands.has(command)) {
      const match = /^(?:path|name) (.+) \(offset \d+\)$/.exec(text);
      if (match) {
        paths.push(match[1]);
      }
    }
  }
  assert.ok(paths.length > 0, "otool output must contain loader paths");
  const leaked = paths.filter((path) => path.includes(checkout));
  assert.deepEqual(leaked, [], `shipped loader paths contain the checkout: ${leaked.join(", ")}`);
}
