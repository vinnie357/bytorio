import assert from "node:assert/strict";
import { test } from "node:test";
import { manifestFixture } from "./fixtures/sdk-manifest.mjs";
import {
  maxManifestBytes,
  orderedSdkVersions,
  parseSdkManifest,
  sdkCompatibility,
  sdkReleaseVersion,
} from "./sdk-manifest.mjs";

const encode = (value) => Buffer.from(JSON.stringify(value));

test("distribution identities stay separate from cartridge API/profile versions", () => {
  const manifest = manifestFixture("3.1.0-preview.2");
  const parsed = parseSdkManifest(encode(manifest), "3.1.0-preview.2");
  assert.equal(parsed.version, "3.1.0-preview.2");
  assert.equal(parsed.profiles[0].sdk, "0.2.0");
  assert.throws(() => parseSdkManifest(encode(manifest), "3.1.0-preview.3"), /identity mismatch/);
});

test("SDK versions use SemVer ordering and explicit prerelease eligibility", () => {
  const versions = [
    "0.2.0-preview.2",
    "0.2.0-preview.10",
    "0.2.0",
    "0.10.0",
    "0.9.0",
    "1.0.0-rc.1",
    "0.2.0",
    "latest",
    "sdk-v1.0.0",
    "01.0.0",
    "1.0",
    "1.0.0+mutable",
  ];
  assert.deepEqual(orderedSdkVersions(versions, { allowPrerelease: false }), [
    "0.10.0",
    "0.9.0",
    "0.2.0",
  ]);
  assert.deepEqual(orderedSdkVersions(versions, { allowPrerelease: true }), [
    "1.0.0-rc.1",
    "0.10.0",
    "0.9.0",
    "0.2.0",
    "0.2.0-preview.10",
    "0.2.0-preview.2",
  ]);
  assert.throws(() => orderedSdkVersions(versions, {}), /eligibility must be explicit/);
  for (const version of ["latest", "../escape", "v1.0.0", "01.0.0", "1.0.0-01", "1.0.0+build"]) {
    assert.throws(() => sdkReleaseVersion(version));
  }
});

test("SDK compatibility covers CLI, language tools and requested player target", () => {
  const manifest = parseSdkManifest(encode(manifestFixture()));
  const requirements = {
    cliVersion: "0.1.0-preview.7",
    language: "luau",
    host: "macos-x64",
    target: "web",
  };
  assert.equal(sdkCompatibility(manifest, requirements), null);
  assert.match(
    sdkCompatibility(manifest, { ...requirements, language: "odin" }),
    /Odin|odin.*macos-x64/,
  );
  assert.match(sdkCompatibility(manifest, { ...requirements, target: "native" }), /native player/);
  assert.match(
    sdkCompatibility(manifest, { ...requirements, cliVersion: "1.0.0" }),
    /requires byt/,
  );
  assert.match(
    sdkCompatibility({ ...manifest, cliProtocol: 1 }, requirements),
    /unsupported distribution/,
  );
  assert.match(
    sdkCompatibility(manifest, { ...requirements, target: "unknown" }),
    /unsupported player/,
  );
  assert.match(
    sdkCompatibility(manifest, { ...requirements, profile: "unavailable-profile" }),
    /cartridge profile/,
  );
});

test("manifests reject incomplete capabilities, unsafe payload references and unsupported metadata", () => {
  const mutations = [
    (manifest) => {
      manifest.schema = 1;
    },
    (manifest) => {
      manifest.cliProtocol = 999;
    },
    (manifest) => {
      manifest.cliVersionRange = "nonsense";
    },
    (manifest) => {
      manifest.unrecognized = true;
    },
    (manifest) => {
      manifest.components.core.asset = "../../archive.tar.gz";
    },
    (manifest) => {
      manifest.components.core.bytes = 2 ** 40;
    },
    (manifest) => {
      manifest.components.core.sha256 = "invalid";
    },
    (manifest) => {
      manifest.authoring.component = "missing";
    },
    (manifest) => {
      manifest.web.runtime.path = "../outside.js";
    },
    (manifest) => {
      manifest.defaults.profile = "missing";
    },
    (manifest) => {
      manifest.profiles.push({ ...manifest.profiles[0] });
    },
    (manifest) => {
      delete manifest.limits.moduleBytes;
    },
    (manifest) => {
      manifest.starters.luau.entry = "wrong/main.luau";
    },
    (manifest) => {
      manifest.starters.luau.source = "x".repeat(32769);
    },
    (manifest) => {
      delete manifest.starters.odin;
    },
    (manifest) => {
      delete manifest.check.workers.odin;
    },
    (manifest) => {
      delete manifest.check.luauExecutor;
    },
    (manifest) => {
      delete manifest.languages.odin.hosts["windows-x64"].compiler;
    },
    (manifest) => {
      delete manifest.languages.odin.hosts["macos-arm64"].linker;
    },
    (manifest) => {
      manifest.languages.luau.hosts["invalid-host"] = {};
    },
    (manifest) => {
      manifest.native["macos-x64"] = { component: "missing", path: "player" };
    },
  ];
  for (const mutate of mutations) {
    const manifest = manifestFixture();
    mutate(manifest);
    assert.throws(() => parseSdkManifest(encode(manifest)), undefined, mutate.toString());
  }
  assert.throws(() => parseSdkManifest(Buffer.alloc(maxManifestBytes + 1)), /byte limit/);
  assert.throws(
    () => parseSdkManifest(encode({ schema: 1, version: "0.1.0", cliProtocol: 1 })),
    /missing required fields/,
  );
});
