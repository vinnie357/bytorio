import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { exportPlayer, stagePlayerSupport } from "./player-export.mjs";
import { nativePlayer, repo, sdlLibraryName, windowsHost } from "./toolchain.mjs";

// Fixture bytes are not Mach-O, so skip real signing.
const sign = async () => {};

async function put(root, name, content = name) {
  const path = join(root, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function fixture(platform) {
  const root = await mkdtemp(join(tmpdir(), "player-export-"));
  const source = join(root, "source");
  const target = join(root, "target");
  const compilerRoot = join(root, "compiler");
  const dependency = join(root, "wasmtime/lib");
  const sdlRoot = join(root, "sdl3");
  await put(compilerRoot, "LICENSE");
  if (platform === "native") {
    for (const name of [
      "vendor/sdl3/SDL3.dll",
      "vendor/sdl3/LICENSE.txt",
      "vendor/OpenGL/LICENSE",
      "vendor/OpenGL/LICENSE_glad",
    ]) {
      await put(compilerRoot, name);
    }
    await put(sdlRoot, `install/lib/${sdlLibraryName}`);
    await put(sdlRoot, "SDL3-3.4.2/LICENSE.txt");
    await put(dependency, "wasmtime.dll");
    await put(dependency, "../LICENSE");
    await put(source, nativePlayer);
  } else {
    for (const name of ["runtime.wasm", "runtime-gpu.wasm", "audio.wasm"]) {
      await put(source, name);
    }
  }
  await stagePlayerSupport({ platform, target: source, compilerRoot, dependency, sdlRoot });
  return { platform, source, target, sign };
}

test("browser export contains the dependencies requested by its scripts", async () => {
  const options = await fixture("web");
  await put(options.source, "game.wasm", "not part of the player");
  await put(options.source, "fixtures/trap.wasm", "not part of the player");
  await put(options.source, "licenses/extra.txt", "additional notice");
  await put(options.target, "game.png", "caller cartridge");
  await exportPlayer(options);
  for (const name of ["runtime-gpu.wasm", "frame-clock.js", "gpu.js", "licenses/odin.txt"]) {
    assert.deepEqual(
      await readFile(join(options.target, name)),
      await readFile(join(options.source, name)),
    );
  }
  for (const name of await readdir(options.target)) {
    if (!name.endsWith(".js")) {
      continue;
    }
    const source = await readFile(join(options.target, name), "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\s*)["'](\.\/[^"']+)["']/g)) {
      await readFile(resolve(options.target, match[1]));
    }
  }
  const gpu = await readFile(join(options.target, "gpu.js"), "utf8");
  const requestedShaders = [...gpu.matchAll(/"([\w-]+\.(?:vert|frag))"/g)];
  assert.ok(requestedShaders.length >= 7);
  for (const [, name] of requestedShaders) {
    assert.ok((await readFile(join(options.target, "gpu-shaders", name))).length > 0);
  }
  assert.equal(await readFile(join(options.target, "game.png"), "utf8"), "caller cartridge");
  assert.equal(
    await readFile(join(options.target, "licenses/extra.txt"), "utf8"),
    "additional notice",
  );
  await assert.rejects(readFile(join(options.target, "game.wasm")), { code: "ENOENT" });
  await assert.rejects(readFile(join(options.target, "fixtures/trap.wasm")), { code: "ENOENT" });
  await assert.rejects(readFile(join(options.target, "luau-executor.wasm")), { code: "ENOENT" });
});

test("native export includes the runtime libraries and their notices", async () => {
  const options = await fixture("native");
  await exportPlayer(options);
  const binaries = [nativePlayer, sdlLibraryName, ...(windowsHost ? ["wasmtime.dll"] : [])];
  for (const name of binaries) {
    assert.deepEqual(
      await readFile(join(options.target, name)),
      await readFile(join(options.source, name)),
    );
  }
  assert.deepEqual((await readdir(join(options.target, "licenses"))).sort(), [
    "glad.txt",
    "odin.txt",
    "ogg.txt",
    "opengl.txt",
    "sdl3.txt",
    "vorbis.txt",
    "wasmtime.txt",
  ]);
  await assert.rejects(readFile(join(options.target, "player.html")), { code: "ENOENT" });
});

test("missing required dependencies fail before changing an existing export", async () => {
  const options = await fixture("web");
  await put(options.target, "player.js", "last working export");
  for (const name of [
    "gpu.js",
    "gpu-shaders/present.frag",
    "runtime-gpu.wasm",
    "licenses/odin.txt",
  ]) {
    const path = join(options.source, name);
    const original = await readFile(path);
    await unlink(path);
    await assert.rejects(exportPlayer(options), { code: "ENOENT" });
    assert.deepEqual(await readdir(options.target), ["player.js"]);
    assert.equal(await readFile(join(options.target, "player.js"), "utf8"), "last working export");
    await writeFile(path, original);
  }
});

test("export rejects unsupported hosts and exporting over its source", async () => {
  const options = await fixture("web");
  await assert.rejects(exportPlayer({ ...options, platform: "unknown" }), /platform/);
  await assert.rejects(exportPlayer({ ...options, target: options.source }), /must differ/);
});

async function assertNoTemporaryNotices(target) {
  const entries = await readdir(join(target, "licenses"), { recursive: true });
  assert.deepEqual(
    entries.filter((name) => name.split(/[\\/]/).some((part) => part.startsWith(".tmp-"))),
    [],
    "atomic staging folders must never be exported",
  );
}

test("license exports skip stale atomic staging folders (#164)", async (t) => {
  const options = await fixture("native");
  t.after(() => rm(dirname(options.source), { recursive: true, force: true }));
  await put(options.source, "licenses/.tmp-deadbeef/unfinished.txt", "partial notice");
  await exportPlayer(options);
  await assertNoTemporaryNotices(options.target);
  assert.equal(
    await readFile(join(options.target, "licenses/odin.txt"), "utf8"),
    await readFile(join(options.source, "licenses/odin.txt"), "utf8"),
  );
});

test("license exports tolerate concurrent atomic staging (#164)", async (t) => {
  const options = await fixture("native");
  t.after(() => rm(dirname(options.source), { recursive: true, force: true }));
  const notice = join(dirname(options.source), "notice.txt");
  await writeFile(notice, "additional license notice\n".repeat(4096));
  // Separate event loops let staging remove folders while cp is traversing them.
  const script = `
    import { copyAtomic } from "./tools/atomic-file.mjs";
    import { join } from "node:path";
    let stopped = false;
    process.on("message", () => { stopped = true; });
    const notice = ${JSON.stringify(notice)};
    const licenses = ${JSON.stringify(join(options.source, "licenses"))};
    const stage = () => Promise.all(Array.from({ length: 16 }, (_, index) =>
      copyAtomic(notice, join(licenses, "extra-" + index + ".txt"))));
    await stage();
    process.send("ready");
    while (!stopped) {
      await stage();
    }
    process.disconnect();
  `;
  const worker = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repo,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  worker.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const completed = new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("close", (code) => resolve(code));
  });
  const ready = new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("close", (code) => reject(new Error(`staging exited ${code}: ${stderr}`)));
  });
  try {
    assert.equal(await ready, "ready");
    for (let iteration = 0; iteration < 200; iteration++) {
      const target = join(dirname(options.target), `export-${iteration}`);
      await assert.doesNotReject(
        exportPlayer({ ...options, target }),
        `export ${iteration} must tolerate concurrent license staging`,
      );
      await assertNoTemporaryNotices(target);
      await rm(target, { recursive: true, force: true });
    }
  } finally {
    try {
      if (worker.connected) {
        await new Promise((resolve, reject) => {
          worker.send("stop", (error) => (error ? reject(error) : resolve()));
        });
      }
    } finally {
      assert.equal(await completed, 0, stderr);
    }
  }
});
