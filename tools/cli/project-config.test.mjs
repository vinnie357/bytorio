import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { stringify } from "smol-toml";
import {
  createGameProject,
  parseLock,
  parseProject,
  readGameProject,
  resolveGameProject,
  selectProjectSdk,
  serializeLock,
  upgradeGameSdk,
} from "./project-config.mjs";
import { manifestFixture } from "./fixtures/sdk-manifest.mjs";
import { resolveSdkRelease } from "./sdk-registry.mjs";

test("TOML config separates author settings from exact portable SDK pins", () => {
  const config = parseProject(
    'schema = 1\ntitle = "Game"\n[[content]]\nid = 1\npath = "assets/data.bin"\n',
  );
  assert.equal(config.language, "luau");
  assert.equal(
    parseProject('schema = 1\n[player.controls]\npreset="pointer"\n').player.controls.preset,
    "pointer",
  );
  assert.deepEqual(
    config.content.map(({ id, path }) => ({ id, path })),
    [{ id: 1, path: "assets/data.bin" }],
  );
  const release = { manifest: manifestFixture(), sha256: "a".repeat(64) };
  const source = serializeLock(release);
  assert.deepEqual(parseLock(source), {
    version: release.manifest.version,
    sha256: release.sha256,
  });
  assert.ok(!source.includes("components/") && !source.includes("cache"));
  for (const input of [
    "schema = 2",
    'schema = 1\nlanguage = "other"',
    'schema = 1\nlaguage = "luau"',
    "schema = 1\ntitle = false",
    "schema = 1\nschema = 1",
  ]) {
    assert.throws(() => parseProject(input));
  }
  for (const pin of [
    { schema: 1, sdk: { version: "latest", sha256: "a".repeat(64) } },
    { schema: 1, sdk: { version: "0.2.0", sha256: "invalid" } },
    { schema: 1, sdk: { version: "0.2.0", sha256: "a".repeat(64), path: "/cache" } },
  ]) {
    assert.throws(() => parseLock(stringify(pin)));
  }
});

test("explicit upgrades preserve authored TOML and recover a missing lock offline", async () =>
  fixture(async ({ root, options }) => {
    const release = await selectProjectSdk("luau", "0.2.0-preview.1", options);
    const directory = resolve(root, "upgrade game");
    await createGameProject(directory, "luau", release);
    const config = resolve(directory, "bytorio.toml");
    const original = (await readFile(config, "utf8")) + "\n# Keep this comment\n";
    await writeFile(config, original);
    await upgradeGameSdk(directory, "0.3.0-preview.1", options);
    assert.equal((await readGameProject(directory)).pin.version, "0.3.0-preview.1");
    assert.equal(await readFile(config, "utf8"), original);
    await rm(resolve(directory, "bytorio.lock.toml"));
    await upgradeGameSdk(directory, undefined, { ...options, offline: true });
    assert.equal((await readGameProject(directory)).pin.version, "0.3.0-preview.1");
  }));

async function fixture(run) {
  const root = await mkdtemp(resolve(tmpdir(), "byt-project-config-"));
  const requests = [];
  const releases = new Map();
  for (const version of ["0.2.0-preview.1", "0.3.0-preview.1"]) {
    releases.set(version, Buffer.from(JSON.stringify(manifestFixture(version))));
  }
  const server = createServer((request, response) => {
    requests.push(request.url);
    const version = request.url.split("/")[1]?.slice(5);
    const bytes = releases.get(version);
    if (bytes) {
      response.end(bytes);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const options = {
    cliVersion: "0.2.0-preview.1",
    host: "windows-x64",
    cache: resolve(root, "cache"),
    releaseRoot: `http://127.0.0.1:${server.address().port}`,
  };
  try {
    await run({ root, requests, releases, options });
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
}

test("new games have three files and stay pinned when a newer SDK becomes installed", async () =>
  fixture(async ({ root, requests, releases, options }) => {
    const release = await selectProjectSdk("luau", "0.2.0-preview.1", options);
    const directory = resolve(root, "minimal game");
    await createGameProject(directory, "luau", release);
    assert.deepEqual((await readdir(directory)).sort(), [
      "bytorio.lock.toml",
      "bytorio.toml",
      "src",
    ]);
    assert.deepEqual(await readdir(resolve(directory, "src")), ["main.luau"]);
    await resolveSdkRelease("0.3.0-preview.1", options);
    const count = requests.length;
    const newest = await selectProjectSdk("luau", undefined, { ...options, offline: true });
    assert.equal(newest.manifest.version, "0.3.0-preview.1");
    const game = await resolveGameProject(directory, { ...options, offline: true });
    assert.equal(game.release.manifest.version, "0.2.0-preview.1");
    assert.equal(
      game.pin.sha256,
      createHash("sha256").update(releases.get(game.pin.version)).digest("hex"),
    );
    assert.equal(requests.length, count);
    await assert.rejects(createGameProject(directory, "odin", release), /already exists/);
    assert.equal((await readGameProject(directory)).config.language, "luau");
    await writeFile(
      resolve(directory, "bytorio.lock.toml"),
      stringify({
        schema: 1,
        sdk: { version: game.pin.version, sha256: "b".repeat(64) },
      }),
    );
    await assert.rejects(
      resolveGameProject(directory, { ...options, offline: true }),
      /corrupt|pin|checksum/,
    );
  }));

test("project parsing rejects missing or oversized configuration without changing user files", async () =>
  fixture(async ({ root }) => {
    const directory = resolve(root, "authored game");
    await mkdir(directory);
    await writeFile(resolve(directory, "notes.txt"), "keep these notes");
    await assert.rejects(readGameProject(directory), /No bytorio.toml/);
    await writeFile(resolve(directory, "bytorio.toml"), 'schema = 1\nlanguage = "odin"\n');
    await assert.rejects(readGameProject(directory), /Missing bytorio.lock.toml/);
    await writeFile(resolve(directory, "bytorio.toml"), Buffer.alloc(1024 * 1024 + 1));
    await assert.rejects(readGameProject(directory), /no larger than 1 MiB/);
    assert.equal(await readFile(resolve(directory, "notes.txt"), "utf8"), "keep these notes");
  }));
