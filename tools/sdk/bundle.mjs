import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, dirname, relative, sep } from "node:path";
import { formatSource } from "../code-tools.mjs";
import { PROFILE_ALPHA_3D, PROFILE_OGG } from "../../runtime/odin/web/constants.js";

const contract = JSON.parse(await readFile(new URL("../../sdk/contract.json", import.meta.url)));

// Optional SDK modules are loaded inside helpers, never during SDK initialization.
// Older profiles keep their source budget and fail explicitly if a new helper is called.
const SDK_MODULE_PROFILES = new Map([
  ["billboard.luau", PROFILE_ALPHA_3D],
  ["ogg.luau", PROFILE_OGG],
]);

// Only literal require("@bytorio") and relative module paths are supported.
// Tokenization protects comments and strings from accidental source rewriting.
function tokens(source) {
  const result = [];
  let i = 0;
  while (i < source.length) {
    const start = i,
      c = source[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (source.startsWith("--", i)) {
      i += 2;
      const long = source.slice(i).match(/^\[(=*)\[/);
      if (long) {
        const end = source.indexOf("]" + long[1] + "]", i + long[0].length);
        if (end < 0) {
          throw new Error("Unclosed Luau comment");
        }
        i = end + long[1].length + 2;
      } else {
        const end = source.indexOf("\n", i);
        i = end < 0 ? source.length : end;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      let value = "";
      while (i < source.length && source[i] !== c) {
        if (source[i] === "\\") {
          value += "\\" + source[++i];
          i++;
        } else {
          value += source[i++];
        }
      }
      if (i === source.length) {
        throw new Error("Unclosed Luau string");
      }
      i++;
      result.push({ kind: "string", value, start, end: i });
      continue;
    }
    const long = source.slice(i).match(/^\[(=*)\[/);
    if (long) {
      const end = source.indexOf("]" + long[1] + "]", i + long[0].length);
      if (end < 0) {
        throw new Error("Unclosed Luau string");
      }
      i = end + long[1].length + 2;
      result.push({ kind: "opaque", start, end: i });
      continue;
    }
    // Interpolation is opaque. require inside interpolation is intentionally unsupported.
    if (c === "`") {
      i++;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i++] === "`") {
          break;
        }
      }
      result.push({ kind: "opaque", start, end: i });
      continue;
    }
    const identifier = source.slice(i).match(/^[A-Za-z_][A-Za-z_0-9]*/);
    if (identifier) {
      i += identifier[0].length;
      result.push({ kind: "id", value: identifier[0], start, end: i });
      continue;
    }
    result.push({ kind: "punct", value: c, start, end: ++i });
  }
  return result;
}
// Removes comments and indentation from Luau source and keeps every newline, so a line in the
// result is the line it came from and a runtime error still reports the source line. Strings,
// long strings and interpolated strings are copied byte for byte, so comment markers inside them
// are untouched. Nothing is renamed or reflowed. A profile directive on the very first line is
// kept, because the host reads it.
export function stripComments(source) {
  const length = source.length;
  let out = "";
  let i = 0;
  let atLineStart = true;
  if (source.startsWith("--!")) {
    const end = source.indexOf("\n");
    i = end < 0 ? length : end;
    out = source.slice(0, i);
  }
  const trimEnd = () => {
    out = out.replace(/[ \t]+$/, "");
  };
  while (i < length) {
    const c = source[i];
    if (c === "\n") {
      trimEnd();
      out += "\n";
      i++;
      atLineStart = true;
      continue;
    }
    if (atLineStart && (c === " " || c === "\t")) {
      i++;
      continue;
    }
    atLineStart = false;
    if (c === "-" && source[i + 1] === "-") {
      const long = source.slice(i + 2).match(/^\[(=*)\[/);
      if (long) {
        const close = "]" + long[1] + "]";
        const end = source.indexOf(close, i + 2 + long[0].length);
        if (end < 0) {
          throw new Error("Unclosed Luau comment");
        }
        out += "\n".repeat(source.slice(i, end).split("\n").length - 1);
        i = end + close.length;
        // The code after a block comment keeps one space from what came before it.
        trimEnd();
        while (source[i] === " " || source[i] === "\t") {
          i++;
        }
        if (i < length && source[i] !== "\n" && out !== "" && !out.endsWith("\n")) {
          out += " ";
        }
        atLineStart = out === "" || out.endsWith("\n");
        continue;
      }
      const end = source.indexOf("\n", i);
      i = end < 0 ? length : end;
      trimEnd();
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const start = i++;
      while (i < length && source[i] !== c) {
        i += source[i] === "\\" ? 2 : 1;
      }
      if (i >= length) {
        throw new Error("Unclosed Luau string");
      }
      i++;
      out += source.slice(start, i);
      continue;
    }
    const long = c === "[" ? source.slice(i).match(/^\[(=*)\[/) : null;
    if (long) {
      const close = "]" + long[1] + "]";
      const end = source.indexOf(close, i + long[0].length);
      if (end < 0) {
        throw new Error("Unclosed Luau string");
      }
      out += source.slice(i, end + close.length);
      i = end + close.length;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export async function bundleLuau({
  entry,
  project,
  sdkRoot,
  assets,
  assetsContent,
  display = [640, 360],
  profile = 1,
  strip = true,
}) {
  if (!contract.profiles.some(({ id }) => id === profile)) {
    throw new Error("Unsupported Luau cartridge profile");
  }
  project = await realpath(project);
  sdkRoot = await realpath(sdkRoot);
  const native = resolve(sdkRoot, "native.luau"),
    sdkEntry = resolve(sdkRoot, "bytorio.luau");
  const modules = new Map(),
    visiting = new Set();
  async function resolveModule(request, from) {
    if (request === "@bytorio") {
      return sdkEntry;
    }
    if (!request.startsWith("./") && !request.startsWith("../")) {
      throw new Error(`Unsupported require: ${request}`);
    }
    if (request.includes("\\")) {
      throw new Error("Use forward slashes in module paths");
    }
    const base = resolve(dirname(from), request);
    for (const candidate of [base + ".luau", resolve(base, "init.luau")]) {
      try {
        const file = await realpath(candidate);
        if ((await stat(file)).isFile()) {
          const root = from.startsWith(sdkRoot + sep) ? sdkRoot : project;
          if (!file.startsWith(root + sep)) {
            throw new Error("Module escapes its project");
          }
          return file;
        }
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
          throw error;
        }
      }
    }
    throw new Error(`Missing module: ${request}`);
  }
  async function visit(file) {
    file = await realpath(file);
    if (file === native) {
      return "$native";
    }
    const root = file.startsWith(sdkRoot + sep) ? sdkRoot : project;
    if (!file.startsWith(root + sep)) {
      throw new Error("Entry/module escapes its project");
    }
    const id = (root === sdkRoot ? "$sdk/" : "") + relative(root, file).replaceAll("\\", "/");
    if (visiting.has(id)) {
      throw new Error(`Cyclic require: ${id}`);
    }
    if (modules.has(id)) {
      return id;
    }
    visiting.add(id);
    const source = await readFile(file, "utf8");
    if (Buffer.byteLength(source) > 256 * 1024 || modules.size + visiting.size > 256) {
      throw new Error("Luau module graph exceeds preview limits");
    }
    const lex = tokens(source),
      edits = [];
    for (let i = 0; i < lex.length; i++) {
      const t = lex[i];
      if (t.kind !== "id" || t.value !== "require" || [".", ":"].includes(lex[i - 1]?.value)) {
        continue;
      }
      if (
        lex[i + 1]?.value !== "(" ||
        lex[i + 2]?.kind !== "string" ||
        lex[i + 3]?.value !== ")" ||
        lex[i + 2].value.includes("\\")
      ) {
        throw new Error("require must use one literal module path");
      }
      const dependencyFile = await resolveModule(lex[i + 2].value, file);
      const minimumProfile = dependencyFile.startsWith(sdkRoot + sep)
        ? SDK_MODULE_PROFILES.get(relative(sdkRoot, dependencyFile).replaceAll("\\", "/"))
        : undefined;
      const unavailable = minimumProfile !== undefined && profile < minimumProfile;
      const dependency = unavailable ? null : await visit(dependencyFile);
      edits.push({
        start: t.start,
        end: lex[i + 3].end,
        text: unavailable
          ? `(error("This SDK helper requires cartridge profile ${minimumProfile}"))`
          : `__require(${JSON.stringify(dependency)})`,
      });
      i += 3;
    }
    let rewritten = source;
    for (const edit of edits.reverse()) {
      rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end);
    }
    visiting.delete(id);
    modules.set(id, rewritten);
    return id;
  }
  const sdkId = await visit(sdkEntry),
    mainId = await visit(entry);
  const output = [
    `-- SDK bundled cartridge. Generated; edit project sources instead.\nlocal __native=console\nlocal __modules,__cache={},{}\nlocal function __require(id:string):any\n    if id=="$native" then return __native end\n    if __cache[id]~=nil then return __cache[id] end\n    local value=__modules[id]()\n    assert(value~=nil,"module must return a value")\n    __cache[id]=value;return value\nend`,
  ];
  for (const [id, source] of modules) {
    output.push(`__modules[${JSON.stringify(id)}]=function()\n${source}\nend`);
  }
  output.push(
    `local __sdk=__require(${JSON.stringify(sdkId)})\n__sdk.assets(${assetsContent !== undefined ? assetsContent : JSON.stringify(assets.toString("base64"))})\nreturn __sdk._wrap(__require(${JSON.stringify(mainId)}),${display[0]},${display[1]})\n`,
  );
  // Comments cost cartridge bytes and the player never reads them; the sources keep theirs.
  // Stripping runs after formatting, so the formatter's layout is the layout the lines keep.
  const formatted = formatSource(output.join("\n"), "game.luau");
  const bytes = Buffer.from(
    (profile !== 1 ? `--!console-profile=${profile}\n` : "") +
      (strip ? stripComments(formatted) : formatted),
    "utf8",
  );
  if (bytes.length > 256 * 1024) {
    throw new Error(`Bundled Luau source exceeds 256 KiB (${bytes.length} bytes)`);
  }
  return bytes;
}
export function odinEntry({ graphicsImport = '"assets"', display = "High" } = {}) {
  if (!["High", "Low"].includes(display)) {
    throw new Error("Invalid display mode");
  }
  return formatSource(
    `// Generated SDK entry point.\npackage main\nimport "base:runtime"\nimport byt "sdk:bytorio"\nimport ${graphicsImport}\n@(export) game_init :: proc "c" () {\n context=runtime.default_context()\n byt.start(byt.Callbacks{init=init,update=update,draw=draw},byt.Config{graphics=assets.raster[:],display=.${display}})\n}\n`,
    "bytorio_entry.odin",
  );
}
