import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { parse } from "smol-toml";
import { createProject } from "./sdk/project.mjs";
import { manifestFixture } from "./cli/fixtures/sdk-manifest.mjs";
import { repo } from "./toolchain.mjs";
import { requireCliHost } from "./host-platform.mjs";
import { cliVersion } from "./release-config.mjs";

const temporaryRoot = resolve(tmpdir());
const sandbox = await mkdtemp(resolve(temporaryRoot, "bytorio-cli-"));
assert.ok(sandbox.startsWith(temporaryRoot + sep));
const reportDirectory = resolve(repo, "build/cli-verification");
await mkdir(reportDirectory, { recursive: true });
const host = requireCliHost();
const executable = resolve(sandbox, host.executable);
const execute = promisify(execFile);
const requests = [];
const metadata = new Map();
const listing = [];
for (const version of ["0.2.0-preview.1", "0.3.0-preview.1"]) {
  const manifest = manifestFixture(version);
  // Metadata-only fixture; real host tools and players have separate qualification.
  manifest.languages.odin.hosts[host.id] ??= manifest.languages.odin.hosts["macos-arm64"];
  for (const language of ["luau", "odin"]) {
    manifest.starters[language].source = await readFile(
      resolve(repo, `sdk/templates/main.${language}`),
      "utf8",
    );
  }
  metadata.set(version, Buffer.from(JSON.stringify(manifest)));
}
listing.push({ tag_name: "sdk-v0.2.0-preview.1", draft: false, prerelease: true });
const legacyVersion = "0.1.0-preview.1";
const legacyRoot = resolve(repo, "build/sdk-release", legacyVersion);
const legacyMetadata = await readFile(resolve(legacyRoot, "sdk-release.json"));
const legacyManifest = JSON.parse(legacyMetadata);
const legacyArchive = await readFile(resolve(legacyRoot, legacyManifest.asset));
const server = createServer((request, response) => {
  requests.push(request.url);
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  if (path === "/catalogue") {
    response.end(JSON.stringify(listing));
    return;
  }
  const match = /^\/sdk-v([^/]+)\/sdk-release.json$/.exec(path);
  if (match && metadata.has(match[1])) {
    response.end(metadata.get(match[1]));
  } else if (path === `/sdk-v${legacyVersion}/sdk-release.json`) {
    response.end(legacyMetadata);
  } else if (path === `/sdk-v${legacyVersion}/${legacyManifest.asset}`) {
    response.end(legacyArchive);
  } else {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^(path|mise.*|node.*|bun.*)$/i.test(name)),
);
Object.assign(environment, {
  PATH: "",
  BYTORIO_CACHE_DIR: resolve(sandbox, "shared cache"),
  BYTORIO_SDK_RELEASE_ROOT: base,
  BYTORIO_SDK_CATALOGUE_URL: `${base}/catalogue`,
});

async function invoke(args, success = true) {
  let result;
  try {
    result = await execute(executable, args, {
      cwd: sandbox,
      env: environment,
      timeout: 30000,
      windowsHide: true,
    });
  } catch (error) {
    if (success) {
      throw new Error(`${args.join(" ")} failed: ${error.stderr || error.message}`, {
        cause: error,
      });
    }
    assert.equal(error.signal, null, "Invalid command crashed instead of reporting an error");
    return error;
  }
  assert.equal(success, true, "Invalid command unexpectedly succeeded");
  return result;
}

async function inventory(root, prefix = "") {
  const files = {};
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(files, await inventory(root, name));
    } else {
      files[name] = createHash("sha256")
        .update(await readFile(resolve(root, name)))
        .digest("hex");
    }
  }
  return files;
}

try {
  await copyFile(resolve(repo, "build/cli", host.executable), executable);
  await writeFile(resolve(sandbox, ".env"), "NODE_OPTIONS=--invalid-byt-option\n");
  await writeFile(resolve(sandbox, "bunfig.toml"), 'preload = ["./missing.js"]\n');
  assert.match((await invoke(["--help"])).stdout, /bytorio.toml/);
  const expectedVersion = cliVersion(process.env.BYTORIO_RELEASE_TAG);
  assert.equal((await invoke(["--version"])).stdout.trim(), expectedVersion);
  const release = JSON.parse(await readFile(resolve(repo, "build/cli/release.json"), "utf8"));
  assert.equal(release.version, expectedVersion);
  assert.equal(release.platform, host.id);
  assert.equal(
    release.sha256,
    createHash("sha256")
      .update(await readFile(executable))
      .digest("hex"),
  );
  const projects = [];
  for (const language of ["luau", "odin"]) {
    const name = `${language} game with spaces`;
    const args = language === "luau" ? ["new", name] : ["new", name, "--language", language];
    const before = requests.length;
    await invoke(args);
    if (language === "odin") {
      assert.equal(requests.length, before, "Installed SDK selection contacted the network");
    }
    const project = resolve(sandbox, name);
    const files = await inventory(project);
    assert.deepEqual(Object.keys(files).sort(), [
      "bytorio.lock.toml",
      "bytorio.toml",
      `src/main.${language}`,
    ]);
    const config = parse(await readFile(resolve(project, "bytorio.toml"), "utf8"));
    const lock = parse(await readFile(resolve(project, "bytorio.lock.toml"), "utf8"));
    assert.equal(config.language, language);
    assert.equal(config.schema, 1);
    assert.equal(lock.sdk.version, "0.2.0-preview.1");
    assert.equal(
      lock.sdk.sha256,
      createHash("sha256").update(metadata.get(lock.sdk.version)).digest("hex"),
    );
    const source = await readFile(resolve(project, `src/main.${language}`), "utf8");
    assert.equal(source, JSON.parse(metadata.get(lock.sdk.version)).starters[language].source);
    assert.match((await invoke(args, false)).stderr, /already exists/);
    assert.deepEqual(await inventory(project), files);
    projects.push({ language, files: Object.keys(files).length });
  }
  await invoke(["sdk", "install", "0.3.0-preview.1"]);
  const installedRequests = requests.length;
  await invoke(["new", "newest installed", "--offline"]);
  assert.equal(requests.length, installedRequests);
  const newest = parse(
    await readFile(resolve(sandbox, "newest installed/bytorio.lock.toml"), "utf8"),
  );
  assert.equal(newest.sdk.version, "0.3.0-preview.1");
  await invoke(["new", "explicit older", "--sdk", "0.2.0-preview.1", "--offline"]);
  assert.equal(requests.length, installedRequests);
  assert.ok(!requests.some((path) => path.endsWith(".tar.gz")), "Creation downloaded payloads");
  await invoke(["sdk", "install", legacyVersion]);
  await invoke(["new", "legacy", "--sdk", legacyVersion, "--offline"]);
  const reference = resolve(sandbox, "legacy reference");
  await createProject(reference, "luau");
  const legacyFiles = await inventory(resolve(sandbox, "legacy"));
  delete legacyFiles["byt.lock.json"];
  assert.deepEqual(legacyFiles, await inventory(reference));
  for (const args of [
    ["new", "invalid", "--language", "python"],
    ["new", "invalid", "--language"],
    ["new", "invalid", "--surprise"],
    ["new", "invalid", "--language", "odin", "extra"],
    ["new"],
    ["unknown"],
    ["--help", "extra"],
  ]) {
    await invoke(args, false);
  }
  for (const action of ["watch", "import"]) {
    assert.match((await invoke([action, "luau game with spaces"], false)).stderr, /not available/);
  }
  for (const action of ["check", "build", "pack", "run"]) {
    const failed = await invoke([action, "luau game with spaces", "--offline"], false);
    assert.match(failed.stderr, /SDK component .*not cached/);
  }
  await writeFile(
    resolve(reportDirectory, "report.json"),
    JSON.stringify(
      {
        status: "passed",
        isolatedCwd: true,
        emptyPath: true,
        minimalProjects: true,
        installedFirst: true,
        noPayloadDownloads: true,
        legacyScaffolding: true,
        projects,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Standalone CLI passed: minimal pinned projects, installed-first preview selection, no payload downloads, offline reuse and explicit legacy scaffolding.",
  );
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await rm(sandbox, { recursive: true, force: true });
}
