import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { authorOptions } from "./arguments.mjs";
import {
  assertCartridgeOutput,
  createBuildStage,
  publishBuild,
  removeGenerated,
  snapshotWeb,
} from "./output.mjs";
import { startPreview } from "./preview.mjs";
import { createScaffolder } from "../sdk/scaffold.mjs";
import { repo } from "../toolchain.mjs";
import { watchesProjectFile } from "./dev.mjs";

test("development watches authored inputs and excludes generated output", () => {
  for (const path of [
    "src/main.luau",
    "assets/build/texture.png",
    "bytorio.toml",
    "bytorio.lock.toml",
  ]) {
    assert.equal(watchesProjectFile(path), true);
  }
  for (const path of ["build/web/game.png", ".bytorio/staging/output", ".git/index", ".luaurc"]) {
    assert.equal(watchesProjectFile(path), false);
  }
});

test("development preview reloads complete generations while preserving old asset URLs", async () =>
  fixture(async (root) => {
    await mkdir(resolve(root, "build/web"), { recursive: true });
    await writeFile(
      resolve(root, "build/web/player.html"),
      "<html><head></head><body>First</body></html>",
    );
    const game = {
      directory: root,
      buildRoot: resolve(root, "build"),
      release: { manifest: { web: { page: { path: "player.html" } } } },
    };
    const preview = await startPreview(game, { open: false, reload: true });
    const abort = new AbortController();
    try {
      const initial = await fetch(preview.url);
      const html = await initial.text();
      const id = /data-generation="([^"]+)"/.exec(html)[1];
      assert.match(html, /__byt\/client.js/);
      const events = await fetch(`${preview.url}__byt/events?id=${id}`, { signal: abort.signal });
      const reader = events.body.getReader();
      assert.match(new TextDecoder().decode((await reader.read()).value), new RegExp(id));
      await writeFile(
        resolve(root, "build/web/player.html"),
        "<html><head></head><body>Second</body></html>",
      );
      await preview.update(game);
      assert.doesNotMatch(new TextDecoder().decode((await reader.read()).value), new RegExp(id));
      assert.match(await (await fetch(preview.url)).text(), /Second/);
      // Independent files in actual builds are replaced atomically; use a distinct asset here.
      assert.equal((await fetch(initial.url)).status, 200);
      await reader.cancel();
    } finally {
      abort.abort();
      await preview.close();
    }
  }));

test("author commands use web defaults and reject ambiguous or unsupported flags", () => {
  assert.equal(authorOptions([], "build").target, "web");
  assert.equal(authorOptions([], "run").open, true);
  assert.equal(authorOptions(["--no-open", "--port", "0"], "run").open, false);
  assert.deepEqual(authorOptions(["--target", "native", "--", "--smoke"], "run").playerArgs, [
    "--smoke",
  ]);
  for (const [action, args] of [
    ["build", ["--target", "other"]],
    ["run", ["--port", "65536"]],
    ["check", ["--target", "web"]],
    ["run", ["--offline", "--offline"]],
    ["build", ["first", "second"]],
    ["run", ["--", "--smoke"]],
  ]) {
    assert.throws(() => authorOptions(args, action));
  }
});

async function fixture(run) {
  const root = await mkdtemp(resolve(tmpdir(), "byt-output-"));
  try {
    await run(root);
  } finally {
    await removeGenerated(root);
  }
}

test("cartridge output protection resolves aliases and nonexistent destination suffixes", async () =>
  fixture(async (root) => {
    const project = resolve(root, "game");
    const alias = resolve(root, "alias");
    for (const target of ["web", "native"]) {
      await mkdir(resolve(project, "build", target), { recursive: true });
      await writeFile(resolve(project, "build", target, "game.png"), "retained cartridge");
    }
    await symlink(project, alias, process.platform === "win32" ? "junction" : "dir");
    const canonical = await realpath(project);
    for (const target of ["web", "native"]) {
      for (const file of ["game.png", "new/nested/cartridge.png"]) {
        await assert.rejects(
          assertCartridgeOutput(canonical, resolve(alias, "build", target, file)),
          /cannot overwrite a player export/,
        );
      }
      assert.equal(
        await readFile(resolve(project, "build", target, "game.png"), "utf8"),
        "retained cartridge",
      );
    }
    await assertCartridgeOutput(canonical, resolve(alias, "dist/deep/game.png"));
    await assertCartridgeOutput(canonical, resolve(alias, "build/game.png"));
    assert.deepEqual(await readdir(project), ["build"]);
  }));

test("publication preserves unrelated build folders and replaces complete owned exports", async () =>
  fixture(async (root) => {
    const stage = await createBuildStage(root);
    await writeFile(resolve(stage, "game.png"), "first cartridge");
    await mkdir(resolve(root, "build"));
    await writeFile(resolve(root, "build/notes.txt"), "authored notes");
    await assert.rejects(publishBuild(root, stage), /not owned by byt/);
    assert.equal(await readFile(resolve(root, "build/notes.txt"), "utf8"), "authored notes");
    await rm(resolve(root, "build"), { recursive: true });
    await rm(resolve(stage, ".bytorio-output.json"));
    await publishBuild(root, stage);
    const next = await createBuildStage(root);
    await writeFile(resolve(next, "game.png"), "second cartridge");
    await publishBuild(root, next);
    assert.equal(await readFile(resolve(root, "build/game.png"), "utf8"), "second cartridge");
    assert.deepEqual(await readdir(resolve(root, ".bytorio/staging")), []);
  }));

test("immutable web snapshots survive replacement of public build outputs", async () =>
  fixture(async (root) => {
    const stage = await createBuildStage(root);
    await mkdir(resolve(stage, "web"));
    await writeFile(resolve(stage, "web/player.html"), "first page");
    await publishBuild(root, stage);
    const snapshot = await snapshotWeb(root, resolve(root, "build/web"));
    const replacement = await createBuildStage(root);
    await mkdir(resolve(replacement, "web"));
    await writeFile(resolve(replacement, "web/player.html"), "second page");
    await publishBuild(root, replacement);
    assert.equal(await readFile(resolve(snapshot, "player.html"), "utf8"), "first page");
    assert.equal(await readFile(resolve(root, "build/web/player.html"), "utf8"), "second page");
  }));

async function exportStage(root, cartridge, targets) {
  const stage = await createBuildStage(root);
  await writeFile(resolve(stage, "game.png"), cartridge);
  for (const [target, files] of Object.entries(targets)) {
    await mkdir(resolve(stage, target));
    await writeFile(resolve(stage, target, "game.png"), cartridge);
    for (const [name, value] of Object.entries(files)) {
      await writeFile(resolve(stage, target, name), value);
    }
  }
  return stage;
}

test("pack and target changes retain complete independent player exports", async () =>
  fixture(async (root) => {
    const first = await exportStage(root, "first game", {
      web: { "player.html": "old web player", "obsolete.js": "removed on rebuild" },
      native: { player: "native player", "sdk.txt": "first SDK" },
    });
    await chmod(resolve(first, "native/player"), 0o755);
    const nativeMode = (await stat(resolve(first, "native/player"))).mode;
    await publishBuild(root, first);
    const snapshot = await snapshotWeb(root, resolve(root, "build/web"));

    const web = await exportStage(root, "web game", { web: { "player.html": "new web player" } });
    const webResult = await publishBuild(root, web);
    assert.deepEqual(webResult.preservedTargets, ["native"]);
    assert.equal(await readFile(resolve(root, "build/native/game.png"), "utf8"), "first game");
    assert.equal(await readFile(resolve(root, "build/native/sdk.txt"), "utf8"), "first SDK");
    assert.equal((await stat(resolve(root, "build/native/player"))).mode, nativeMode);
    assert.deepEqual(await readdir(resolve(root, "build/web")), ["game.png", "player.html"]);
    assert.equal(await readFile(resolve(snapshot, "game.png"), "utf8"), "first game");

    const native = await exportStage(root, "native game", {
      native: { player: "new native player" },
    });
    assert.deepEqual((await publishBuild(root, native)).preservedTargets, ["web"]);
    const pack = await exportStage(root, "packed game", {});
    assert.deepEqual((await publishBuild(root, pack)).preservedTargets, ["web", "native"]);
    assert.equal(await readFile(resolve(root, "build/game.png"), "utf8"), "packed game");
    assert.equal(await readFile(resolve(root, "build/web/game.png"), "utf8"), "web game");
    assert.equal(await readFile(resolve(root, "build/native/game.png"), "utf8"), "native game");
    assert.equal(await readFile(resolve(root, "build/native/player"), "utf8"), "new native player");
    assert.deepEqual(await readdir(resolve(root, ".bytorio/staging")), []);
  }));

test("concurrent target publications retain both completed exports", async () =>
  fixture(async (root) => {
    const web = await exportStage(root, "web game", { web: { "player.html": "web player" } });
    const native = await exportStage(root, "native game", { native: { player: "native player" } });
    await Promise.all([publishBuild(root, web), publishBuild(root, native)]);
    assert.equal(await readFile(resolve(root, "build/web/game.png"), "utf8"), "web game");
    assert.equal(await readFile(resolve(root, "build/native/game.png"), "utf8"), "native game");
    assert.deepEqual(await readdir(resolve(root, ".bytorio/staging")), []);
  }));

test("preserving an export rejects junctions before changing the published build", async () =>
  fixture(async (root) => {
    await publishBuild(root, await exportStage(root, "original", { native: { player: "native" } }));
    const outside = resolve(root, "outside");
    await mkdir(outside);
    await writeFile(resolve(outside, "notes.txt"), "outside data");
    await symlink(
      outside,
      resolve(root, "build/native/assets"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const web = await exportStage(root, "new game", { web: { "player.html": "web" } });
    await assert.rejects(publishBuild(root, web), /links or special files/);
    assert.equal(await readFile(resolve(root, "build/game.png"), "utf8"), "original");
    assert.equal(await readFile(resolve(outside, "notes.txt"), "utf8"), "outside data");
    assert.deepEqual(await readdir(resolve(root, "build")), [
      ".bytorio-output.json",
      "game.png",
      "native",
    ]);
    assert.equal(
      (await readdir(resolve(root, ".bytorio/staging"))).includes("publish.lock"),
      false,
    );
  }));

test("preview serves only the exported snapshot, streams binaries and cleans up", async () =>
  fixture(async (root) => {
    await mkdir(resolve(root, "build/web"), { recursive: true });
    await writeFile(resolve(root, "build/web/player.html"), "<p>Game</p>");
    const wasm = Buffer.alloc(80 * 1024, 17);
    await writeFile(resolve(root, "build/web/runtime.wasm"), wasm);
    await writeFile(resolve(root, "bytorio.toml"), "private config");
    const preview = await startPreview(
      {
        directory: root,
        buildRoot: resolve(root, "build"),
        release: { manifest: { web: { page: { path: "player.html" } } } },
      },
      { open: false },
    );
    try {
      assert.equal(await (await fetch(preview.url)).text(), "<p>Game</p>");
      const binary = await fetch(new URL("runtime.wasm", preview.url));
      assert.equal(binary.headers.get("content-type"), "application/wasm");
      assert.deepEqual(Buffer.from(await binary.arrayBuffer()), wasm);
      const head = await fetch(new URL("runtime.wasm", preview.url), { method: "HEAD" });
      assert.equal(head.headers.get("content-length"), String(wasm.length));
      assert.equal((await head.arrayBuffer()).byteLength, 0);
      assert.equal((await fetch(new URL("bytorio.toml", preview.url))).status, 404);
      assert.equal((await fetch(preview.url, { method: "POST" })).status, 405);
    } finally {
      await preview.close();
    }
    assert.deepEqual(await readdir(resolve(root, ".bytorio/sessions")), []);
  }));

test("preview canonicalizes a project directory alias before checking requested files", async () =>
  fixture(async (root) => {
    const game = resolve(root, "game");
    const alias = resolve(root, "alias");
    await mkdir(resolve(game, "build/web"), { recursive: true });
    await writeFile(resolve(game, "build/web/player.html"), "Aliased game");
    await symlink(game, alias, process.platform === "win32" ? "junction" : "dir");
    const preview = await startPreview(
      {
        directory: alias,
        buildRoot: resolve(alias, "build"),
        release: { manifest: { web: { page: { path: "player.html" } } } },
      },
      { open: false },
    );
    try {
      assert.equal(await (await fetch(preview.url)).text(), "Aliased game");
    } finally {
      await preview.close();
    }
  }));

test("generated directories cannot follow a project junction into another folder", async () =>
  fixture(async (root) => {
    const project = resolve(root, "game");
    const outside = resolve(root, "outside");
    await mkdir(project);
    await mkdir(outside);
    await writeFile(resolve(outside, "notes.txt"), "preserve outside data");
    await symlink(
      outside,
      resolve(project, ".bytorio"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(createBuildStage(project), /links or special files/);
    assert.deepEqual(await readdir(outside), ["notes.txt"]);
  }));

test("SDK editor synchronization preserves authored settings and refuses linked files", async (context) =>
  fixture(async (root) => {
    const { syncEditor } = await createScaffolder({
      readAsset: (path) => readFile(resolve(repo, path), "utf8"),
      branding: { starterTitle: "Game", starterMessage: "Hello" },
    });
    const project = resolve(root, "game");
    await mkdir(project);
    await writeFile(
      resolve(project, ".luaurc"),
      JSON.stringify({
        globals: ["customGlobal"],
        aliases: { custom: "./types" },
      }),
    );
    await syncEditor(project);
    const config = JSON.parse(await readFile(resolve(project, ".luaurc"), "utf8"));
    assert.deepEqual(config.globals, ["customGlobal"]);
    assert.equal(config.aliases.custom, "./types");
    await rm(resolve(project, ".luaurc"));
    const outside = resolve(root, "outside.json");
    await writeFile(outside, "{}");
    try {
      await symlink(outside, resolve(project, ".luaurc"), "file");
    } catch (error) {
      if (process.platform === "win32" && error.code === "EPERM") {
        context.diagnostic(
          "File symlink privilege unavailable; junction protection remains exercised",
        );
        return;
      }
      throw error;
    }
    await assert.rejects(syncEditor(project), /symbolic links/);
    assert.equal(await readFile(outside, "utf8"), "{}");
  }));
