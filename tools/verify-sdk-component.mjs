import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { compileCli } from "./compile-cli.mjs";
import { requireCliHost } from "./host-platform.mjs";
import { repo } from "./toolchain.mjs";
import { packComponent } from "./sdk/component.mjs";
import { manifestFixture } from "./cli/fixtures/sdk-manifest.mjs";

const output = resolve(repo, "build/sdk-component-verification");
await mkdir(output, { recursive: true });
const host = requireCliHost();
const built = resolve(output, host.executable);
compileCli(["tools/cli/component-probe.mjs"], built);
const temporaryRoot = resolve(tmpdir());
const sandbox = await mkdtemp(resolve(temporaryRoot, "byt-component-consumer-"));
assert.ok(sandbox.startsWith(temporaryRoot + sep));
const server = createServer();
const execute = promisify(execFile);
try {
  const executable = resolve(sandbox, host.executable);
  await copyFile(built, executable);
  const payload = resolve(sandbox, "SDK payload");
  await mkdir(resolve(payload, "licenses"), { recursive: true });
  const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  await writeFile(resolve(payload, "tool"), binary);
  await writeFile(resolve(payload, "licenses/sdk.txt"), "SDK license notice\n");
  const archive = resolve(sandbox, "component.tar.gz");
  const descriptor = await packComponent({
    root: payload,
    archive,
    executables: ["tool"],
    notices: ["licenses/sdk.txt"],
  });
  const archiveBytes = await readFile(archive);
  const destination = resolve(sandbox, "installed");
  const request = resolve(sandbox, "request.json");
  await writeFile(request, JSON.stringify({ archive, destination, descriptor }));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(path|mise.*|node.*|bun.*)$/i.test(name)),
  );
  environment.PATH = "";
  const invoke = () =>
    execute(executable, [request], {
      cwd: sandbox,
      env: environment,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    });
  const success = await invoke();
  assert.deepEqual(JSON.parse(success.stdout), { files: 2, notices: ["licenses/sdk.txt"] });
  assert.deepEqual(await readFile(resolve(destination, "tool")), binary);
  await writeFile(archive, "corrupt archive");
  await assert.rejects(
    invoke(),
    (error) => error.code === 1 && /checksum or size mismatch/.test(error.stderr),
  );
  let requests = 0;
  server.on("request", (request, response) => {
    requests++;
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    if (path === "/releases") {
      response.end(
        JSON.stringify([{ tag_name: "sdk-v0.2.0-preview.1", draft: false, prerelease: true }]),
      );
    } else if (path.endsWith("/sdk-release.json")) {
      response.end(JSON.stringify(manifestFixture()));
    } else {
      response.end(archiveBytes);
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const component = {
    id: "sdk-core",
    descriptor,
    url: `http://127.0.0.1:${server.address().port}/component.tar.gz`,
  };
  const cache = resolve(sandbox, "shared cache");
  await writeFile(request, JSON.stringify({ operation: "resolve", component, options: { cache } }));
  const installations = await Promise.allSettled([invoke(), invoke()]);
  for (const installation of installations) {
    assert.equal(installation.status, "fulfilled", installation.reason?.stack);
    const result = JSON.parse(installation.value.stdout);
    assert.ok(result.directory.startsWith(sandbox + sep));
    assert.deepEqual(await readFile(resolve(result.directory, "tool")), binary);
  }
  const onlineRequests = requests;
  await writeFile(
    request,
    JSON.stringify({ operation: "resolve", component, options: { cache, offline: true } }),
  );
  const cached = JSON.parse((await invoke()).stdout);
  assert.equal(requests, onlineRequests);
  await writeFile(resolve(cached.directory, "tool"), "corrupt payload");
  await assert.rejects(
    invoke(),
    (error) => error.code === 1 && /corrupt.*online/.test(error.stderr),
  );
  await writeFile(request, JSON.stringify({ operation: "resolve", component, options: { cache } }));
  const repaired = JSON.parse((await invoke()).stdout);
  assert.notEqual(repaired.directory, cached.directory);
  assert.deepEqual(await readFile(resolve(repaired.directory, "tool")), binary);
  const requirements = {
    cliVersion: "0.1.0-preview.7",
    language: "luau",
    host: "macos-x64",
    target: "web",
  };
  await writeFile(
    request,
    JSON.stringify({ operation: "manifest", manifest: manifestFixture(), requirements }),
  );
  assert.deepEqual(JSON.parse((await invoke()).stdout), {
    version: "0.2.0-preview.1",
    profile: "resource-av-1",
  });
  await writeFile(
    request,
    JSON.stringify({
      operation: "manifest",
      manifest: manifestFixture(),
      requirements: { ...requirements, language: "odin" },
    }),
  );
  await assert.rejects(
    invoke(),
    (error) => error.code === 1 && /odin authoring on macos-x64/.test(error.stderr),
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sdkOptions = {
    cache,
    releaseRoot: origin,
    catalogueRoot: `${origin}/releases`,
    allowPrerelease: true,
  };
  await writeFile(
    request,
    JSON.stringify({
      operation: "select-sdk",
      options: sdkOptions,
      requirements: { ...requirements, host: host.id },
    }),
  );
  const beforeSelection = requests;
  const selected = JSON.parse((await invoke()).stdout);
  assert.equal(selected.version, "0.2.0-preview.1");
  assert.equal(
    requests,
    beforeSelection + 2,
    "Selection fetched more than catalogue and starter metadata",
  );
  await writeFile(
    request,
    JSON.stringify({
      operation: "select-sdk",
      options: { ...sdkOptions, offline: true },
      requirements: { ...requirements, host: host.id },
    }),
  );
  assert.deepEqual(JSON.parse((await invoke()).stdout), selected);
  assert.equal(requests, beforeSelection + 2);
  await writeFile(
    request,
    JSON.stringify({
      operation: "resolve-sdk",
      version: selected.version,
      options: { ...sdkOptions, offline: true, expectedSha256: selected.sha256 },
    }),
  );
  assert.deepEqual(JSON.parse((await invoke()).stdout), selected);
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        status: "passed",
        platform: host.id,
        isolatedCwd: true,
        emptyPath: true,
        checks: [
          "binary payload",
          "notices",
          "archive integrity",
          "no external archiver",
          "HTTP acquisition",
          "concurrent acquisition",
          "offline reuse",
          "corruption repair",
          "SDK metadata and compatibility",
          "installed-first SDK selection",
          "exact SDK metadata pins",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Compiled SDK component extraction passed with an isolated cwd and empty PATH.");
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await rm(sandbox, { recursive: true, force: true });
}
