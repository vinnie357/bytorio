import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { manifestFixture } from "./fixtures/sdk-manifest.mjs";
import { resolveSdkRelease, selectSdkRelease } from "./sdk-registry.mjs";

const requirements = {
  cliVersion: "0.1.0-preview.7",
  host: "windows-x64",
  language: "luau",
  target: "web",
};
const encode = (value) => Buffer.from(JSON.stringify(value));
const digest = (value) => createHash("sha256").update(encode(value)).digest("hex");

async function fixture(run) {
  const root = await mkdtemp(resolve(tmpdir(), "byt-sdk-registry-"));
  const manifests = new Map();
  const requests = [];
  const catalogue = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/releases") {
      const page = Number(url.searchParams.get("page"));
      response.end(JSON.stringify(catalogue.slice((page - 1) * 100, page * 100)));
      return;
    }
    const version = url.pathname.match(/^\/download\/sdk-v([^/]+)\/sdk-release.json$/)?.[1];
    if (!version || !manifests.has(version)) {
      response.writeHead(404).end();
      return;
    }
    response.end(encode(manifests.get(version)));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const options = {
    cache: resolve(root, "cache"),
    releaseRoot: `${origin}/download`,
    catalogueRoot: `${origin}/releases`,
    allowPrerelease: true,
  };
  function release(version, mutate = () => {}, flags = {}) {
    const manifest = manifestFixture(version);
    mutate(manifest);
    manifests.set(version, manifest);
    catalogue.push({
      tag_name: `sdk-v${version}`,
      draft: false,
      prerelease: version.includes("-"),
      ...flags,
    });
    return manifest;
  }
  try {
    await run({ root, options, requests, manifests, catalogue, release });
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
}

test("newest compatible installed SDK wins before any network lookup or payload fetch", async () =>
  fixture(async ({ options, requests, release }) => {
    release("0.2.0-preview.2");
    release("0.2.0-preview.10");
    release("0.3.0", (manifest) => {
      manifest.cliVersionRange = ">=2.0.0";
    });
    await resolveSdkRelease("0.2.0-preview.2", options);
    await resolveSdkRelease("0.2.0-preview.10", options);
    await resolveSdkRelease("0.3.0", options);
    const before = requests.length;
    release("0.9.0");
    const selected = await selectSdkRelease(requirements, options);
    assert.equal(selected.manifest.version, "0.2.0-preview.10");
    assert.equal(requests.length, before);
    assert.equal(
      (await selectSdkRelease(requirements, { ...options, offline: true })).sha256,
      selected.sha256,
    );
    assert.ok(requests.every((url) => url.endsWith("sdk-release.json")));
  }));

test("empty-cache discovery orders by SemVer, skips incompatible and legacy releases and registers only the winner", async () =>
  fixture(async ({ options, requests, release, manifests }) => {
    release("0.9.0", (manifest) => {
      manifest.schema = 1;
      manifest.cliProtocol = 1;
    });
    release("0.8.0", (manifest) => {
      manifest.cliVersionRange = ">=2.0.0";
    });
    release("0.2.0-preview.2");
    release("0.2.0-preview.10");
    release("0.3.0", () => {}, { draft: true });
    const selected = await selectSdkRelease(requirements, options);
    assert.equal(selected.manifest.version, "0.2.0-preview.10");
    assert.equal(selected.sha256, digest(manifests.get("0.2.0-preview.10")));
    assert.deepEqual(await readdir(resolve(options.cache, "sdk/releases")), ["0.2.0-preview.10"]);
    assert.ok(requests.some((url) => url.startsWith("/releases?")));
    assert.ok(!requests.some((url) => url.endsWith(".tar.gz")));
    assert.equal(
      (await selectSdkRelease(requirements, { ...options, offline: true })).manifest.version,
      selected.manifest.version,
    );
  }));

test("stable-only eligibility applies to installed versions and GitHub prerelease flags", async () =>
  fixture(async ({ options, release }) => {
    release("0.2.0");
    release("0.3.0", () => {}, { prerelease: true });
    release("0.4.0-preview.1");
    await resolveSdkRelease("0.4.0-preview.1", options);
    const stable = await selectSdkRelease(requirements, { ...options, allowPrerelease: false });
    assert.equal(stable.manifest.version, "0.2.0");
    assert.equal(
      (await selectSdkRelease(requirements, options)).manifest.version,
      "0.4.0-preview.1",
    );
    await assert.rejects(
      selectSdkRelease(requirements, { ...options, allowPrerelease: undefined }),
      /eligibility must be explicit/,
    );
  }));

test("GitHub preview eligibility survives installation when the version tag has no suffix", async () =>
  fixture(async ({ options, release }) => {
    release("0.2.0");
    release("0.3.0", () => {}, { prerelease: true });
    const preview = await selectSdkRelease(requirements, options);
    assert.equal(preview.manifest.version, "0.3.0");
    assert.equal(preview.prerelease, true);
    const stable = await selectSdkRelease(requirements, { ...options, allowPrerelease: false });
    assert.equal(stable.manifest.version, "0.2.0");
  }));

test("exact pinned SDKs reuse offline, reject mutation and never float to another release", async () =>
  fixture(async ({ options, requests, release, manifests, root }) => {
    const original = release("0.2.0");
    const expectedSha256 = digest(original);
    const pinned = await resolveSdkRelease("0.2.0", { ...options, expectedSha256 });
    assert.equal(pinned.sha256, expectedSha256);
    const before = requests.length;
    await resolveSdkRelease("0.2.0", { ...options, expectedSha256, offline: true });
    assert.equal(requests.length, before);
    manifests.set("0.2.0", {
      ...original,
      defaults: { ...original.defaults, display: [320, 180] },
    });
    const changedSha256 = digest(manifests.get("0.2.0"));
    await assert.rejects(
      resolveSdkRelease("0.2.0", { ...options, expectedSha256: changedSha256 }),
      /Immutable SDK.*changed/,
    );
    await assert.rejects(
      resolveSdkRelease("0.2.0", { ...options, cache: resolve(root, "clean"), expectedSha256 }),
      /differs from.*pin/,
    );
    assert.equal(
      (await resolveSdkRelease("0.2.0", { ...options, expectedSha256, offline: true })).sha256,
      expectedSha256,
    );
    await assert.rejects(
      resolveSdkRelease("0.2.0", { ...options, expectedSha256: "not-a-digest" }),
      /Invalid SDK metadata dependency checksum/,
    );
  }));

test("explicit online upgrades discover newer releases despite an installed SDK", async () =>
  fixture(async ({ options, release }) => {
    release("0.2.0");
    await resolveSdkRelease("0.2.0", options);
    release("0.3.0");
    assert.equal(
      (await selectSdkRelease(requirements, { ...options, preferInstalled: false })).manifest
        .version,
      "0.3.0",
    );
  }));

test("offline misses, unsupported host capabilities and corruption recovery stay explicit", async () =>
  fixture(async ({ options, release, requests }) => {
    await assert.rejects(
      selectSdkRelease(requirements, { ...options, offline: true }),
      /No compatible installed SDK/,
    );
    await assert.rejects(
      resolveSdkRelease("0.2.0", { ...options, offline: true }),
      /not installed/,
    );
    assert.equal(requests.length, 0);
    release("0.2.0");
    await resolveSdkRelease("0.2.0", options);
    const file = resolve(options.cache, "sdk/releases/0.2.0/entry.json");
    await writeFile(file, "corrupt");
    await assert.rejects(resolveSdkRelease("0.2.0", { ...options, offline: true }), /corrupt/);
    const repaired = await resolveSdkRelease("0.2.0", options);
    assert.equal(repaired.manifest.version, "0.2.0");
    assert.ok(JSON.parse(await readFile(file, "utf8")).sha256);
    await assert.rejects(
      selectSdkRelease({ ...requirements, host: "macos-x64", language: "odin" }, options),
      /No compatible standalone SDK/,
    );
  }));

test("catalogue discovery checks later pages and concurrent metadata installation stays complete", async () =>
  fixture(async ({ options, release, catalogue }) => {
    for (let i = 0; i < 100; i++) {
      catalogue.push({ tag_name: `byt-v0.1.0-preview.${i}`, draft: false, prerelease: true });
    }
    release("0.2.0");
    const selected = await selectSdkRelease(requirements, options);
    assert.equal(selected.manifest.version, "0.2.0");
    release("0.3.0");
    const settled = await Promise.allSettled([
      resolveSdkRelease("0.3.0", options),
      resolveSdkRelease("0.3.0", options),
    ]);
    for (const result of settled) {
      assert.equal(result.status, "fulfilled", result.reason?.stack);
    }
    const installed = settled.map((result) => result.value);
    assert.equal(installed[0].sha256, installed[1].sha256);
    assert.deepEqual(await readdir(resolve(options.cache, "sdk/releases/0.3.0")), ["entry.json"]);
  }));
