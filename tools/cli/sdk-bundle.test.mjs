import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { gzipSync, gunzipSync } from "node:zlib";
import { checkVersion, digest, resolveSdk } from "./sdk-bundle.ts";
import { hostPlatform } from "../host-platform.mjs";

const version = "0.1.0-preview.1";
const fixtureRoot = resolve("build/sdk-release", version);
const originalManifest = JSON.parse(
  await readFile(resolve(fixtureRoot, "sdk-release.json"), "utf8"),
);
const originalArchive = await readFile(resolve(fixtureRoot, originalManifest.asset));

test("versioned releases, offline compiled scaffolding, integrity and failed downloads", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "byt-sdk-"));
  let requests = 0;
  let mode = "normal";
  const otherVersion = "0.1.0-preview.2";
  const server = createServer((request, response) => {
    requests++;
    const selected = request.url.includes(`sdk-v${otherVersion}`) ? otherVersion : version;
    const bundle = JSON.parse(gunzipSync(originalArchive).toString());
    bundle.version = selected;
    if (mode === "path") {
      bundle.assets["sdk/../../escape"] = "bad";
    }
    const archive = gzipSync(Buffer.from(JSON.stringify(bundle)));
    const manifest = {
      ...originalManifest,
      version: selected,
      asset: `bytorio-sdk-${selected}.json.gz`,
      bytes: archive.length,
      sha256: digest(archive),
    };
    if (mode === "protocol") {
      manifest.cliProtocol = 999;
    }
    if (mode === "size") {
      manifest.bytes = 1000000000;
    }
    if (request.url.endsWith("sdk-release.json")) {
      response.end(JSON.stringify(manifest));
    } else if (mode === "missing") {
      response.writeHead(404).end();
    } else {
      response.end(mode === "corrupt" ? Buffer.from("bad") : archive);
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const releaseRoot = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const invalid of ["latest", "../escape", "1.0", "1.0.0/escape"]) {
      assert.throws(() => checkVersion(invalid));
    }
    const cache = resolve(temporary, "cache");
    const options = { cache, releaseRoot };
    const results = await Promise.all([resolveSdk(version, options), resolveSdk(version, options)]);
    assert.equal(results[0].manifest.sha256, results[1].manifest.sha256);
    await resolveSdk(otherVersion, options);
    const onlineCount = requests;
    await resolveSdk(version, { ...options, offline: true });
    await resolveSdk(otherVersion, { ...options, offline: true });
    assert.equal(requests, onlineCount);
    await assert.rejects(resolveSdk("9.9.9", { ...options, offline: true }), /not cached/);

    for (const language of ["odin", "luau"]) {
      const project = resolve(temporary, `${language} game`);
      const result = spawnSync(
        resolve("build/cli", hostPlatform().executable),
        ["new", project, "--language", language, "--sdk", version, "--offline"],
        {
          cwd: temporary,
          encoding: "utf8",
          timeout: 30000,
          windowsHide: true,
          env: { ...process.env, PATH: "", BYTORIO_CACHE_DIR: cache },
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      const lock = JSON.parse(await readFile(resolve(project, "byt.lock.json"), "utf8"));
      assert.equal(lock.sdk.version, version);
      assert.equal(lock.sdk.sha256, results[0].manifest.sha256);
      const manifest = JSON.parse(await readFile(resolve(project, "console.json"), "utf8"));
      assert.equal(
        manifest.sdk,
        "0.2.0",
        "Bundle version must not replace cartridge SDK/profile version",
      );
      assert.equal(manifest.language, language);
    }
    for (const failure of ["corrupt", "missing", "protocol", "size", "path"]) {
      mode = failure;
      const failureOptions = { cache: resolve(temporary, failure), releaseRoot };
      await assert.rejects(resolveSdk(version, failureOptions));
      await assert.rejects(resolveSdk(version, { ...failureOptions, offline: true }), /not cached/);
      mode = "normal";
      await resolveSdk(version, failureOptions);
    }
    await writeFile(resolve(cache, "sdk", version, "entry.json"), "corrupt");
    await assert.rejects(resolveSdk(version, options), /Cached SDK .* invalid/);
    await resolveSdk(otherVersion, { ...options, offline: true });
  } finally {
    await new Promise((done) => server.close(done));
    await rm(temporary, { recursive: true, force: true });
  }
});
