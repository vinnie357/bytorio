import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, matchesGlob, relative, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { stagePlayerSupport } from "./player-export.mjs";
import { windowsHost } from "./toolchain.mjs";
import { repo } from "./toolchain.mjs";

const mise = process.env.MISE_BIN || "mise";

function execute(args, cwd = repo, env = process.env) {
  const result = spawnSync(mise, args, { cwd, env, encoding: "utf8", timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
}

const tasks = JSON.parse(execute(["tasks", "ls", "--json"]))
  .map((task) => ({ ...task, name: task.name.replace(/^\/\/:/, "") }))
  .filter(
    ({ name }) =>
      name === "build:odin" ||
      name.startsWith("deps:vorbis") ||
      name.startsWith("deps:sdl3") ||
      name.startsWith("deps:player:") ||
      name.startsWith("deps:trace:"),
  );
const byName = new Map(tasks.map((task) => [task.name, task]));
const forward = (path) => path.replaceAll("\\", "/");

test("aggregate cache covers every player input and output", () => {
  const aggregate = byName.get("build:odin");
  assert.ok(aggregate.sources.includes(".mise/tasks/player.toml"));
  for (const task of tasks.filter(({ name }) => name.startsWith("deps:player:"))) {
    for (const source of task.sources) {
      assert.ok(aggregate.sources.includes(source), `aggregate omits ${task.name} input ${source}`);
    }
    for (const output of task.outputs) {
      assert.ok(
        aggregate.outputs.includes(output),
        `aggregate omits ${task.name} output ${output}`,
      );
    }
  }
});

function covered(file, sources) {
  return sources.some((pattern) => matchesGlob(forward(file), pattern));
}

// This checks the declared input contract against the actual import tree. It is
// deliberately a test, not a second production dependency resolver or cache.
function packageInputs(entry, seen = new Set()) {
  if (seen.has(entry)) {
    return [];
  }
  seen.add(entry);
  const files = [];
  for (const name of readdirSync(resolve(repo, entry))) {
    if (!name.endsWith(".odin")) {
      continue;
    }
    const file = forward(join(entry, name));
    files.push(file);
    const source = readFileSync(resolve(repo, file), "utf8");
    for (const [, dependency] of source.matchAll(/^\s*import\s+(?:[^\s"]+\s+)?"([^"\n]+)"/gm)) {
      if (dependency.startsWith(".")) {
        files.push(...packageInputs(forward(join(entry, dependency)), seen));
      } else if (dependency.startsWith("sdk:")) {
        files.push(...packageInputs(`sdk/odin/${dependency.slice(4)}`, seen));
      }
    }
    for (const [, dependency] of source.matchAll(/#load\("([^"\n]+)"\)/g)) {
      files.push(forward(join(entry, dependency)));
    }
  }
  return files;
}

test("compiled tasks cover local Odin imports and embedded shader inputs", () => {
  const entries = {
    "deps:player:web-cpu": "runtime/odin/web",
    "deps:player:web-gpu": "runtime/odin/web",
    "deps:player:web-audio": "runtime/odin/audio_web",
    "deps:player:native-binary": "runtime/odin/native",
    "deps:player:hello": "examples/hello/odin",
    "deps:player:fixtures": "tests/odin/fixtures",
    "deps:trace:resources": "tests/resources/player",
    "deps:trace:graphics": "tests/graphics/player",
    "deps:trace:audio": "tests/audio/player",
  };
  for (const [name, entry] of Object.entries(entries)) {
    const task = byName.get(name);
    assert.ok(task, name);
    for (const file of packageInputs(entry)) {
      assert.ok(covered(file, task.sources), `${name} omits ${file}`);
    }
    assert.ok(covered(".mise/toolchain.toml", task.sources), `${name} omits toolchain pins`);
  }
});

function put(root, file, text) {
  const path = resolve(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "player-build-cache-"));
  const env = {
    ...process.env,
    MISE_TRUSTED_CONFIG_PATHS: root,
    MISE_TASK_RUN_AUTO_INSTALL: "false",
  };
  const definitions = new Map();
  const outputs = {};
  for (const task of tasks) {
    const file = forward(relative(repo, task.source));
    const header =
      file === "mise.toml" ? `tasks.${JSON.stringify(task.name)}` : JSON.stringify(task.name);
    let text = `[${header}]\n`;
    for (const key of ["sources", "outputs", "depends"]) {
      if (task[key]?.length) {
        text += `${key} = ${JSON.stringify(task[key])}\n`;
      }
    }
    if (task.name === "build:odin") {
      assert.ok(task.run.every((entry) => Object.keys(entry).length === 1 && entry.task));
      text += `run = [${task.run.map((entry) => `{ task = ${JSON.stringify(entry.task)} }`).join(", ")}]\n`;
    } else if (task.outputs.length) {
      outputs[task.name] = task.outputs;
      // These substitute compilers only write tiny files. Shell builtins avoid
      // starting another Node process for every artifact in every scenario.
      const marker = `events/${task.name.replaceAll(":", "-")}`;
      const files = [...task.outputs, marker];
      for (const file of files) {
        mkdirSync(dirname(resolve(root, file)), { recursive: true });
      }
      const commands = task.outputs.map((file) => `echo fixture > "${file}"`);
      if (task.name.startsWith("deps:vorbis")) {
        // Give concurrently scheduled outer and nested graphs time to observe
        // a stale decoder, as happens with a real compiler on hosted runners.
        commands.unshift('node -e "setTimeout(() => {}, 200)"');
      }
      commands.push(`echo executed >> "${marker}"`);
      text += `run = ${JSON.stringify(commands.join(" && "))}\n`;
    }
    definitions.set(file, (definitions.get(file) || "") + text + "\n");
  }
  const config = '[task_config]\nincludes = [".mise/tasks/*.toml"]\n\n';
  definitions.set("mise.toml", config + (definitions.get("mise.toml") || ""));
  for (const [file, content] of definitions) {
    put(root, file, content);
  }
  // Only inputs needed for the invalidation scenarios: no compilers or real
  // build artifacts are used by this scheduler regression test.
  for (const file of [
    ".mise/toolchain.toml",
    "runtime/odin/web/player.js",
    "runtime/odin/web/constants.js",
    "runtime/odin/web/main.odin",
    "runtime/odin/resources/resources.odin",
    "runtime/odin/native/main.odin",
    "runtime/odin/gpu/mesh.frag",
    "runtime/odin/abi/abi.odin",
    "tests/odin/fixtures/main.odin",
    "examples/hello/odin/main.odin",
    "tests/3d/renderer_test.odin",
    "tests/resources/player/main.odin",
    "tests/graphics/player/main.odin",
    "tests/audio/player/main.odin",
  ]) {
    put(root, file, "fixture\n");
  }
  function run(...names) {
    const flags = names[0] === "--force" ? [names.shift()] : [];
    for (const file of readdirSync(resolve(root, "events"))) {
      unlinkSync(resolve(root, "events", file));
    }
    const selection = names.flatMap((name, index) => (index ? [":::", name] : [name]));
    execute(["run", "--jobs", "4", ...flags, ...selection], root, env);
    return Object.keys(outputs)
      .flatMap((name) => {
        const marker = resolve(root, "events", name.replaceAll(":", "-"));
        return existsSync(marker)
          ? readFileSync(marker, "utf8")
              .trim()
              .split("\n")
              .map(() => name)
          : [];
      })
      .sort();
  }
  return { root, run, outputs };
}

test("mise rebuilds only the artifacts affected by edits and missing outputs", async () => {
  const { root, run, outputs } = fixture();
  const targets = ["build:odin", "deps:trace:resources", "deps:trace:graphics", "deps:trace:audio"];
  const all = Object.keys(outputs).sort();
  assert.deepEqual(run(...targets), all);
  assert.deepEqual(run(...targets), [], "unchanged inputs reuse every artifact");
  // The outer graph finishes the shared decoder before the nested graph starts,
  // including forced rebuilds. Every artifact should be built exactly once.
  assert.deepEqual(run("--force", ...targets), all, "force reaches the nested player graph");

  async function edit(file, expected) {
    // Separate modification times on filesystems whose clock has millisecond precision.
    await new Promise((done) => setTimeout(done, 20));
    appendFileSync(resolve(root, file), "\n# changed\n");
    assert.deepEqual(run(...targets), expected.sort(), file);
  }
  await edit("runtime/odin/web/player.js", ["deps:player:web-support"]);
  await edit("tests/3d/renderer_test.odin", []);
  await edit("mise.toml", []);
  await edit("runtime/odin/gpu/mesh.frag", [
    "deps:player:native-binary",
    "deps:player:web-support",
  ]);
  await edit("tests/odin/fixtures/main.odin", ["deps:player:fixtures"]);
  await edit("examples/hello/odin/main.odin", ["deps:player:hello"]);
  await edit("runtime/odin/web/main.odin", ["deps:player:web-cpu", "deps:player:web-gpu"]);
  await edit("runtime/odin/native/main.odin", ["deps:player:native-binary"]);
  put(root, "runtime/odin/web/new_module.odin", "package web\n");
  assert.deepEqual(run(...targets), ["deps:player:web-cpu", "deps:player:web-gpu"]);
  unlinkSync(resolve(root, "runtime/odin/web/new_module.odin"));
  assert.deepEqual(run(...targets), ["deps:player:web-cpu", "deps:player:web-gpu"]);
  await edit("tests/graphics/player/main.odin", ["deps:trace:graphics"]);
  await edit("runtime/odin/resources/resources.odin", [
    "deps:player:web-cpu",
    "deps:player:web-gpu",
    "deps:player:native-binary",
    "deps:trace:resources",
    "deps:trace:graphics",
    "deps:trace:audio",
  ]);
  await edit(".mise/toolchain.toml", all);

  for (const [name, files] of Object.entries(outputs)) {
    const missing = files.at(-1);
    unlinkSync(resolve(root, missing));
    const rebuilt =
      name === "deps:vorbis"
        ? [
            "deps:player:native-binary",
            "deps:player:native-support",
            "deps:player:web-support",
            "deps:trace:audio",
            "deps:trace:graphics",
            "deps:trace:resources",
            name,
            "deps:vorbis:native",
          ]
        : name === "deps:vorbis:native"
          ? [
              "deps:player:native-binary",
              "deps:trace:audio",
              "deps:trace:graphics",
              "deps:trace:resources",
              name,
            ]
          : name === "deps:sdl3:native"
            ? ["deps:player:native-binary", "deps:player:native-support", name]
            : [name];
    assert.deepEqual(run(...targets), rebuilt, `recover missing ${missing} through aggregate`);
    for (const file of files) {
      assert.ok(existsSync(resolve(root, file)));
    }
  }
  assert.deepEqual(run(...targets), []);
});

test("support task outputs cover every staged file", async () => {
  const root = mkdtempSync(join(tmpdir(), "player-support-inventory-"));
  const compilerRoot = resolve(root, "compiler");
  const dependency = resolve(root, "dependency/lib");
  for (const file of [
    "LICENSE",
    "vendor/sdl3/SDL3.dll",
    "vendor/sdl3/LICENSE.txt",
    "vendor/OpenGL/LICENSE",
    "vendor/OpenGL/LICENSE_glad",
  ]) {
    put(compilerRoot, file, "fixture");
  }
  const sdlRoot = resolve(root, "sdl3");
  put(sdlRoot, "install/lib/libSDL3.0.dylib", "fixture");
  put(sdlRoot, "SDL3-3.4.2/LICENSE.txt", "fixture");
  put(dependency, "wasmtime.dll", "fixture");
  put(dependency, "../LICENSE", "fixture");
  function files(directory, prefix = "") {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const name = prefix + entry.name;
      return entry.isDirectory() ? files(resolve(directory, entry.name), name + "/") : [name];
    });
  }
  for (const platform of ["web", "native"]) {
    const target = resolve(root, platform);
    await stagePlayerSupport({ platform, target, compilerRoot, dependency, sdlRoot });
    const declared = byName
      .get(`deps:player:${platform}-support`)
      .outputs.map((file) => file.replace(`build/odin-player/${platform}/`, ""))
      .sort();
    // Hosts without a Wasmtime DLL repeat a staged file; the set is what matters.
    assert.deepEqual(files(target).sort(), [...new Set(declared)], platform);
  }
});

test("copied support with old source timestamps becomes current in mise", async () => {
  const root = mkdtempSync(join(tmpdir(), "copied-support-cache-"));
  const sources = {
    "compiler/LICENSE": "compiler license",
    "compiler/vendor/sdl3/SDL3.dll": "SDL binary",
    "compiler/vendor/sdl3/LICENSE.txt": "SDL license",
    "compiler/vendor/OpenGL/LICENSE": "GL license",
    "compiler/vendor/OpenGL/LICENSE_glad": "glad license",
    "dependency/lib/wasmtime.dll": "runtime binary",
    "dependency/LICENSE": "runtime license",
    "sdl3/install/lib/libSDL3.0.dylib": "SDL dylib",
    "sdl3/SDL3-3.4.2/LICENSE.txt": "SDL license",
  };
  const old = new Date("2000-01-01T00:00:00Z");
  for (const [file, content] of Object.entries(sources)) {
    put(root, `inputs/${file}`, content);
    utimesSync(resolve(root, `inputs/${file}`), old, old);
  }
  // The library whose edits must restage: the Wasmtime DLL on Windows, the SDL3 dylib elsewhere.
  const [library, libraryInput, libraryText] = windowsHost
    ? ["wasmtime.dll", "dependency/lib/wasmtime.dll", "runtime binary"]
    : ["libSDL3.0.dylib", "sdl3/install/lib/libSDL3.0.dylib", "SDL dylib"];
  const outputs = byName.get("deps:player:native-support").outputs;
  const helper = pathToFileURL(resolve(repo, "tools/player-export.mjs")).href;
  put(
    root,
    "stage.mjs",
    `
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { stagePlayerSupport } from ${JSON.stringify(helper)};
await stagePlayerSupport({
  platform: "native",
  target: resolve("build/odin-player/native"),
  compilerRoot: resolve("inputs/compiler"),
  dependency: resolve("inputs/dependency/lib"),
  sdlRoot: resolve("inputs/sdl3"),
});
appendFileSync("executions.txt", "staged\\n");
`,
  );
  const inventory = `sources = ["inputs/**/*", "stage.mjs"]\noutputs = ${JSON.stringify(outputs)}\n`;
  put(
    root,
    "mise.toml",
    `[tasks.stage]\n${inventory}run = ${JSON.stringify(`"${process.execPath}" stage.mjs`)}
[tasks.all]
${inventory}run = [{ task = "stage" }]
`,
  );
  const env = {
    ...process.env,
    MISE_TRUSTED_CONFIG_PATHS: root,
    MISE_TASK_RUN_AUTO_INSTALL: "false",
  };
  function run() {
    execute(["run", "all"], root, env);
    return readFileSync(resolve(root, "executions.txt"), "utf8").trim().split("\n").length;
  }
  assert.equal(run(), 1);
  assert.equal(
    readFileSync(resolve(root, `build/odin-player/native/${library}`), "utf8"),
    libraryText,
  );
  assert.equal(run(), 1, "unchanged copied outputs must not be staged again");

  await new Promise((done) => setTimeout(done, 20));
  put(root, `inputs/${libraryInput}`, "updated binary");
  assert.equal(run(), 2, "real source edits still invalidate staging");
  assert.equal(
    readFileSync(resolve(root, `build/odin-player/native/${library}`), "utf8"),
    "updated binary",
  );
  unlinkSync(resolve(root, outputs.at(-1)));
  assert.equal(run(), 3, "missing declared outputs still invalidate staging");
  assert.ok(outputs.every((file) => existsSync(resolve(root, file))));

  await new Promise((done) => setTimeout(done, 20));
  appendFileSync(resolve(root, "stage.mjs"), "\n// changed build recipe\n");
  assert.equal(run(), 4, "build recipe edits still invalidate staging");
  appendFileSync(resolve(root, "mise.toml"), '\n[tasks.unrelated]\nrun = "echo unrelated"\n');
  const afterConfigEdit = run();
  assert.equal(run(), afterConfigEdit, "first unchanged aggregate invocation reuses staging");
  assert.equal(run(), afterConfigEdit, "second unchanged aggregate invocation reuses staging");
});
