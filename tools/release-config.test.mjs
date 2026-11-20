import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  cliVersion,
  releaseConfig,
  sdkCliVersionRange,
  verifyReleaseAsset,
} from "./release-config.mjs";
import { sdkCompatibility } from "./cli/sdk-manifest.mjs";
import { manifestFixture } from "./cli/fixtures/sdk-manifest.mjs";
import { cliPlatforms } from "./host-platform.mjs";
import { cliReleasePlatform } from "./release-config.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { repo, run } from "./toolchain.mjs";
import { createCliArchive, verifyCliArchive } from "./cli-release-archive.mjs";

test("release tags select independent versions and prerelease status", () => {
  assert.deepEqual(releaseConfig("byt-v1.2.3-rc.2"), {
    tag: "byt-v1.2.3-rc.2",
    kind: "byt",
    version: "1.2.3-rc.2",
    prerelease: true,
  });
  assert.equal(releaseConfig("sdk-v2.0.0").prerelease, false);
  assert.equal(cliVersion("byt-v1.2.3-rc.2"), "1.2.3-rc.2");
  assert.equal(cliVersion("sdk-v2.0.0"), cliVersion());
  for (const tag of [
    undefined,
    "main",
    "byt-v../escape",
    "sdk-v1",
    "byt-v1.0.0\n",
    "other-v1.0.0",
  ]) {
    assert.throws(() => releaseConfig(tag));
  }
});

test("production-player SDK releases require a CLI that supports player project settings", () => {
  const manifest = { ...manifestFixture(), cliVersionRange: sdkCliVersionRange };
  const requirements = { host: "windows-x64", language: "luau", target: "web" };
  assert.match(
    sdkCompatibility(manifest, { ...requirements, cliVersion: "0.2.0-preview.1" }),
    /SDK requires byt/,
  );
  for (const version of ["0.2.0-preview.2", cliVersion(), "0.2.0"]) {
    assert.equal(sdkCompatibility(manifest, { ...requirements, cliVersion: version }), null);
  }
  assert.match(
    sdkCompatibility(manifest, { ...requirements, cliVersion: "0.3.0" }),
    /SDK requires byt/,
  );
});

test("publication requires every tested CLI platform and verifies each binary", async () => {
  const tag = `byt-v0.0.0-test.${randomUUID()}`;
  const directory = resolve(repo, "build/releases", tag);
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.from("platform release fixture");
  const invoke = (args = []) =>
    spawnSync(process.execPath, ["tools/publish-release.mjs", "--check", ...args], {
      cwd: repo,
      env: { ...process.env, BYTORIO_RELEASE_TAG: tag },
      encoding: "utf8",
    });
  for (const id of cliPlatforms) {
    const host = cliReleasePlatform(id);
    await writeFile(resolve(directory, host.cliAsset), bytes);
    const manifest = {
      version: tag.slice(5),
      platform: id,
      executable: host.executable,
      asset: host.cliAsset,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    await writeFile(
      resolve(directory, host.cliManifest),
      JSON.stringify(
        await createCliArchive(
          releaseConfig(tag),
          manifest,
          resolve(directory, host.cliAsset),
          directory,
        ),
      ),
    );
    const local = invoke(["--platform", id]);
    assert.ifError(local.error);
    assert.equal(local.status, 0, local.stderr);
    if (id !== cliPlatforms.at(-1)) {
      assert.notEqual(invoke().status, 0, "missing platform blocks publication");
    }
  }
  assert.equal(invoke().status, 0);
  const archiveHost = cliReleasePlatform("windows-x64");
  const archive = resolve(directory, archiveHost.cliArchive);
  const original = await readFile(archive);
  await writeFile(archive, Buffer.from("invalid archive"));
  assert.notEqual(invoke().status, 0, "corrupt archive blocks publication");
  await writeFile(archive, original);
  const host = cliReleasePlatform("macos-arm64");
  const path = resolve(directory, host.cliAsset);
  await writeFile(path, Buffer.concat([await readFile(path), Buffer.from("corrupt")]));
  assert.notEqual(invoke().status, 0, "corrupt Mac binary blocks publication");
});

test("publication refuses mismatched versions, filenames, size and corrupted bytes", () => {
  const bytes = Buffer.from("release fixture");
  for (const platform of [...cliPlatforms, "sdk"]) {
    const kind = platform === "sdk" ? "sdk" : "byt";
    const host = kind === "byt" ? cliReleasePlatform(platform) : undefined;
    const release = releaseConfig(`${kind}-v1.2.3`);
    const filenameKey = kind === "byt" ? "executable" : "asset";
    const manifest = {
      version: "1.2.3",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      [filenameKey]: host ? host.executable : "bytorio-sdk-1.2.3.json.gz",
      ...(host ? { platform, asset: host.cliAsset } : {}),
    };
    verifyReleaseAsset(release, manifest, bytes);
    for (const change of [
      { version: "1.2.4" },
      { bytes: bytes.length + 1 },
      { sha256: "0".repeat(64) },
      { [filenameKey]: "wrong-file" },
    ]) {
      assert.throws(() => verifyReleaseAsset(release, { ...manifest, ...change }, bytes));
    }
    assert.throws(() => verifyReleaseAsset(release, manifest, Buffer.from("changed fixture")));
    if (host) {
      assert.throws(() => verifyReleaseAsset(release, manifest, bytes, "linux-x64"));
      for (const other of cliPlatforms.filter((id) => id !== platform)) {
        assert.throws(() => verifyReleaseAsset(release, manifest, bytes, other));
      }
      assert.throws(() => verifyReleaseAsset(release, { ...manifest, asset: "wrong" }, bytes));
    }
  }
});

test("archive verification rejects extra files and a different executable despite a matching archive hash", async () => {
  const release = releaseConfig(`byt-v0.0.0-test.${randomUUID()}`);
  const host = cliReleasePlatform("windows-x64");
  const directory = resolve(repo, "build/releases", release.tag);
  await mkdir(directory, { recursive: true });
  const executable = resolve(directory, host.executable);
  const original = Buffer.from("tested CLI payload");
  await writeFile(executable, original);
  const manifest = {
    version: release.version,
    platform: host.id,
    executable: host.executable,
    asset: host.cliAsset,
    bytes: original.length,
    sha256: createHash("sha256").update(original).digest("hex"),
  };
  const packaged = await createCliArchive(release, manifest, executable, directory);
  const archive = resolve(directory, host.cliArchive);
  const check = async () => {
    const bytes = await readFile(archive);
    const changed = {
      ...packaged,
      archive: {
        asset: host.cliArchive,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
    await assert.rejects(verifyCliArchive(release, changed, archive));
  };
  await writeFile(resolve(directory, "extra.txt"), "extra payload");
  run("tar", ["-czf", archive, "-C", directory, host.executable, "extra.txt"]);
  await check();
  await writeFile(executable, Buffer.from("different CLI payload"));
  run("tar", ["-czf", archive, "-C", directory, host.executable]);
  await check();
});
