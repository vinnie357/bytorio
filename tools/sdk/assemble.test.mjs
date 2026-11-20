import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { packComponent } from "./component.mjs";
import { assembleSdk } from "./assemble.mjs";
import { manifestFixture } from "../cli/fixtures/sdk-manifest.mjs";
import { produceLuauHostSdk } from "./luau-host.mjs";
import { verifySdkRelease } from "./release.mjs";

async function fixture(run) {
  const root = await mkdtemp(resolve(tmpdir(), "byt-sdk-assembly-"));
  try {
    async function candidate(host) {
      const directory = resolve(root, host);
      await mkdir(directory);
      const manifest = manifestFixture();
      const tools = `tools-${host}`;
      const native = `native-${host}`;
      const ref = (component, path) => ({ component, path });
      manifest.authoring = ref("core", "authoring.mjs");
      manifest.contract = ref("core", "sdk/contract.json");
      manifest.check = {
        runtime: ref("checks", "runtime.wasm"),
        workers: { luau: ref("checks", "check.mjs"), odin: ref("checks", "check.mjs") },
        luauExecutor: ref("executor", "luau-executor.wasm"),
      };
      manifest.web = {
        runtime: ref("web", "runtime.js"),
        player: ref("web", "player.js"),
        page: ref("web", "player.html"),
      };
      manifest.languages = {
        luau: {
          libraries: ref("core", "sdk/luau"),
          hosts: { [host]: { analyzer: ref(tools, "analyzer") } },
        },
        odin: {
          libraries: ref("core", "sdk/odin"),
          hosts: {
            [host]: { compiler: ref(tools, "compiler"), linker: ref(tools, "bin/wasm-ld") },
          },
        },
      };
      manifest.native = { [host]: ref(native, "player") };
      manifest.components = {};
      const payloads = {
        core: {
          "authoring.mjs": `SDK authoring built on ${host}`,
          "sdk/contract.json": "{}",
          "sdk/templates/assets.json": "{}",
          "sdk/luau/byt.luau": "return {}",
          "sdk/odin/byt.odin": "package byt",
        },
        checks: { "runtime.wasm": `runtime built on ${host}`, "check.mjs": "checker" },
        executor: { "luau-executor.wasm": "executor", "licenses/luau.txt": "Luau license" },
        web: { "runtime.js": "runtime", "player.js": "player", "player.html": "page" },
        [tools]: { analyzer: "analyzer", compiler: "compiler", "bin/wasm-ld": "linker" },
        [native]: { player: `player for ${host}` },
      };
      for (const [id, files] of Object.entries(payloads)) {
        const source = resolve(directory, "payloads", id);
        for (const [path, value] of Object.entries({ ...files, NOTICE: "SDK notice" })) {
          await mkdir(dirname(resolve(source, path)), { recursive: true });
          await writeFile(resolve(source, path), value);
        }
        const asset = `${id}.tar.gz`;
        manifest.components[id] = {
          asset,
          ...(await packComponent({
            root: source,
            archive: resolve(directory, asset),
            notices: ["NOTICE"],
            executables:
              id === tools
                ? ["analyzer", "compiler", "bin/wasm-ld"]
                : id === native
                  ? ["player"]
                  : [],
          })),
        };
      }
      const save = () =>
        writeFile(resolve(directory, "sdk-release.json"), JSON.stringify(manifest));
      await save();
      return { host, directory, manifest, save };
    }
    const windows = await candidate("windows-x64");
    const mac = await candidate("macos-arm64");
    await run({ root, windows, mac });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("assembly uses canonical shared bytes and preserves each host's tools and native player", async () =>
  fixture(async ({ root, windows, mac }) => {
    const output = resolve(root, "release");
    const result = await assembleSdk({
      candidates: [windows, mac],
      canonicalHost: windows.host,
      output,
    });
    assert.equal(result.manifest.components.core.sha256, windows.manifest.components.core.sha256);
    assert.notEqual(result.manifest.components.core.sha256, mac.manifest.components.core.sha256);
    assert.deepEqual(Object.keys(result.manifest.languages.odin.hosts).sort(), [
      "macos-arm64",
      "windows-x64",
    ]);
    for (const host of [windows, mac]) {
      const id = `native-${host.host}`;
      const descriptor = host.manifest.components[id];
      assert.deepEqual(result.manifest.components[id], descriptor);
      assert.deepEqual(
        await readFile(resolve(output, descriptor.asset)),
        await readFile(resolve(host.directory, descriptor.asset)),
      );
    }
    await assert.rejects(
      assembleSdk({ candidates: [windows, mac], canonicalHost: windows.host, output }),
      { code: "EEXIST" },
    );
  }));

test("assembly refuses incompatible contracts and foreign-host claims before publication", async () =>
  fixture(async ({ root, windows, mac }) => {
    mac.manifest.limits.moduleBytes++;
    await mac.save();
    await assert.rejects(
      assembleSdk({
        candidates: [windows, mac],
        canonicalHost: windows.host,
        output: resolve(root, "mismatch"),
      }),
      /differ in limits/,
    );
    mac.manifest.limits.moduleBytes--;
    mac.manifest.languages.luau.hosts[windows.host] = mac.manifest.languages.luau.hosts[mac.host];
    await mac.save();
    await assert.rejects(
      assembleSdk({
        candidates: [windows, mac],
        canonicalHost: windows.host,
        output: resolve(root, "foreign"),
      }),
      /another host/,
    );
  }));

test("assembly never publishes corrupt component archives", async () =>
  fixture(async ({ root, windows, mac }) => {
    await writeFile(
      resolve(mac.directory, mac.manifest.components[`native-${mac.host}`].asset),
      "truncated",
    );
    const output = resolve(root, "corrupt");
    await assert.rejects(
      assembleSdk({ candidates: [windows, mac], canonicalHost: windows.host, output }),
      /checksum or size mismatch/,
    );
    await assert.rejects(readFile(resolve(output, "sdk-release.json")), { code: "ENOENT" });
    await assert.rejects(readFile(resolve(output, windows.manifest.components.core.asset)), {
      code: "ENOENT",
    });
  }));

test("assembly checks entrypoints against the verified archive inventory", async () =>
  fixture(async ({ root, windows, mac }) => {
    mac.manifest.native[mac.host].path = "missing-player";
    await mac.save();
    await assert.rejects(
      assembleSdk({
        candidates: [windows, mac],
        canonicalHost: windows.host,
        output: resolve(root, "missing"),
      }),
      /entrypoint is missing/,
    );
  }));

test("a Luau-only Intel candidate joins the canonical shared release and is fully verified", async () =>
  fixture(async ({ root, windows, mac }) => {
    const analyzer = resolve(root, "luau-analyze");
    await writeFile(analyzer, "Intel analyzer");
    const intel = await produceLuauHostSdk({
      base: windows.directory,
      output: resolve(root, "intel"),
      host: "macos-x64",
      analyzer,
    });
    assert.deepEqual(Object.keys(intel.manifest.languages), ["luau"]);
    const { output } = await assembleSdk({
      candidates: [windows, mac, { host: "macos-x64", directory: intel.output }],
      canonicalHost: windows.host,
      output: resolve(root, "release"),
    });
    const release = await verifySdkRelease(output, windows.manifest.version);
    assert.ok(release.languages.luau.hosts["macos-x64"]);
    assert.equal(release.languages.odin.hosts["macos-x64"], undefined);
    assert.equal(release.native["macos-x64"], undefined);
    await writeFile(resolve(output, release.components["luau-macos-x64"].asset), "corrupt archive");
    await assert.rejects(verifySdkRelease(output, release.version), /checksum|size/);
  }));

test("assembly rejects asset collisions before copying release files", async () =>
  fixture(async ({ root, windows, mac }) => {
    mac.manifest.components[`native-${mac.host}`].asset = mac.manifest.components.core.asset;
    await mac.save();
    await assert.rejects(
      assembleSdk({
        candidates: [windows, mac],
        canonicalHost: windows.host,
        output: resolve(root, "collision"),
      }),
      /asset name is not unique/,
    );
  }));
