import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep, toNamespacedPath } from "node:path";
import { promisify } from "node:util";
import { cliPlatforms, requireCliHost } from "./host-platform.mjs";
import { cliReleasePlatform, releaseConfig, verifyReleaseAsset } from "./release-config.mjs";
import { createCliArchive } from "./cli-release-archive.mjs";
import { repo } from "./toolchain.mjs";

const execute = promisify(execFile);
const backend = "github:ctxshift/bytorio";
const controller = process.env.MISE_BIN || "mise";
const miseVersion = process.env.BYTORIO_MISE_VERSION || "2025.12.0";
assert.match(miseVersion, /^\d{4}\.\d+\.\d+$/);
const requested = process.env.BYTORIO_CLI_VERSION || "latest";
const host = requireCliHost();
const sandbox = await mkdtemp(join(tmpdir(), "bytorio archive install "));
const output = resolve(repo, "build/cli-archive-verification", basename(sandbox));
await mkdir(output, { recursive: true });
const report = { status: "running", platform: host.id, miseVersion, checks: [] };
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^_*MISE_/i.test(key)),
);
for (const key of ["CONFIG", "DATA", "STATE"]) {
  environment[`MISE_${key}_DIR`] = resolve(sandbox, key.toLowerCase());
}
Object.assign(environment, {
  MISE_CACHE_DIR: resolve(repo, "build/cli-install-cache"),
  MISE_GLOBAL_CONFIG_FILE: resolve(sandbox, "global.toml"),
  MISE_SYSTEM_CONFIG_FILE: resolve(sandbox, "system.toml"),
  MISE_CEILING_PATHS: [sandbox, toNamespacedPath(sandbox)].join(delimiter),
  MISE_TRUSTED_CONFIG_PATHS: sandbox,
  MISE_YES: "1",
});
let command = 0;
async function invoke(executable, args, cwd, env = environment) {
  const log = resolve(output, `${++command}.log`);
  try {
    const result = await execute(executable, args, {
      cwd,
      env,
      timeout: 240000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    await writeFile(log, `${result.stdout}\n${result.stderr}`);
    return result.stdout.trim();
  } catch (error) {
    await writeFile(log, `${error.stdout ?? ""}\n${error.stderr ?? ""}`);
    throw new Error(`Installation command failed; see ${log}`, { cause: error });
  }
}
async function download(url, json = false) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers =
    url.startsWith("https://api.github.com/") && token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(240000) });
  assert.equal(response.status, 200, url);
  return json ? response.json() : Buffer.from(await response.arrayBuffer());
}

let server;
try {
  const metadata =
    requested === "latest"
      ? (await download("https://api.github.com/repos/ctxshift/bytorio/releases", true)).find(
          (entry) => !entry.draft && entry.tag_name.startsWith("byt-v"),
        )
      : await download(
          `https://api.github.com/repos/ctxshift/bytorio/releases/tags/${
            requested.startsWith("byt-v") ? requested : `byt-v${requested}`
          }`,
          true,
        );
  assert.ok(metadata, "A published CLI release is required");
  const release = releaseConfig(metadata.tag_name);
  report.version = release.version;
  const releaseRoot = `https://github.com/ctxshift/bytorio/releases/download/${release.tag}`;
  let manifest = JSON.parse((await download(`${releaseRoot}/${host.cliManifest}`)).toString());
  const source = resolve(sandbox, host.executable);
  const bytes = await download(`${releaseRoot}/${host.cliAsset}`);
  verifyReleaseAsset(release, manifest, bytes, host.id);
  await writeFile(source, bytes);

  const bootstrap = resolve(sandbox, "bootstrap");
  await mkdir(bootstrap);
  await writeFile(
    resolve(bootstrap, "mise.toml"),
    `[tools]\n"github:jdx/mise" = "${miseVersion}"\n`,
  );
  await invoke(controller, ["install", "github:jdx/mise"], bootstrap);
  const installer = await invoke(controller, ["which", "mise"], bootstrap);
  assert.ok(resolve(installer).startsWith(resolve(environment.MISE_DATA_DIR) + sep));
  assert.ok((await invoke(installer, ["--version"], bootstrap)).startsWith(miseVersion + " "));

  const consumer = resolve(sandbox, "game workspace");
  await mkdir(consumer);
  const consumerEnvironment = { ...environment, MISE_DATA_DIR: resolve(sandbox, "consumer-data") };
  let options = `"${release.tag}"`;
  if (manifest.archive) {
    report.mode = "published release";
    assert.equal(manifest.archive.asset, host.cliArchive);
  } else {
    assert.equal(requested, "latest", "The requested release predates archive distribution");
    // Before publication, exercise the actual packaging helper with a released
    // binary. Only the metadata endpoint is redirected; asset matching is unchanged.
    report.mode = "candidate archive fixture";
    manifest = await createCliArchive(release, manifest, source, resolve(sandbox, "candidate"));
    const names = cliPlatforms.flatMap((platform) => {
      const target = cliReleasePlatform(platform);
      return [target.cliAsset, target.cliArchive, target.cliManifest];
    });
    const downloaded = [];
    server = createServer((request, response) => {
      const path = new URL(request.url, base).pathname;
      if (path.startsWith("/repos/ctxshift/bytorio/releases")) {
        // Older clients probe a leading v before the literal tag. Both fixture
        // routes serve the same metadata; live tests retain GitHub's real routing.
        const record = {
          ...metadata,
          tag_name: release.tag,
          draft: false,
          prerelease: true,
          assets: names.map((name, id) => ({
            ...metadata.assets[0],
            id: id + 1,
            name,
            size: manifest.archive.bytes,
            digest: name === host.cliArchive ? `sha256:${manifest.archive.sha256}` : null,
            url: `${base}/assets/${id + 1}`,
            browser_download_url: `${base}/assets/${id + 1}`,
          })),
        };
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(path.endsWith("/releases") ? [record] : record));
        return;
      }
      const name = names[Number(path.slice("/assets/".length)) - 1];
      if (name !== host.cliArchive) {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.setHeader("content-length", manifest.archive.bytes);
      if (request.method === "HEAD") {
        response.end();
      } else {
        downloaded.push(name);
        createReadStream(resolve(sandbox, "candidate", name)).pipe(response);
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    options = `{ version = "${release.tag}", api_url = "${base}" }`;
    report.downloaded = downloaded;
  }
  await writeFile(resolve(consumer, "mise.toml"), `[tools]\n"${backend}" = ${options}\n`);
  await invoke(installer, ["install", backend], consumer, consumerEnvironment);
  if (server) {
    assert.deepEqual(report.downloaded, [host.cliArchive]);
  } else {
    assert.ok(
      (await readFile(resolve(output, `${command}.log`), "utf8")).includes(host.cliArchive),
      "The live install selected the platform archive",
    );
  }
  const installed = await invoke(installer, ["which", "byt"], consumer, consumerEnvironment);
  assert.ok(resolve(installed).startsWith(resolve(consumerEnvironment.MISE_DATA_DIR) + sep));
  verifyReleaseAsset(release, manifest, await readFile(installed), host.id);
  assert.equal(
    await invoke(installer, ["exec", "--", "byt", "--version"], consumer, consumerEnvironment),
    release.version,
  );
  for (const language of ["luau", "odin"]) {
    await invoke(
      installer,
      [
        "exec",
        "--",
        "byt",
        "new",
        `${language} game`,
        "--language",
        language,
        "--sdk",
        "0.1.0-preview.1",
      ],
      consumer,
      consumerEnvironment,
    );
    const project = JSON.parse(
      await readFile(resolve(consumer, `${language} game`, "console.json"), "utf8"),
    );
    assert.equal(project.language, language);
  }
  report.checks.push(
    "Older mise selects the platform archive with no asset, format or executable-name options",
  );
  report.checks.push("Installed payload matches the published raw binary and runs as byt");
  report.checks.push("Both language starters are created through mise exec");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  throw error;
} finally {
  if (server) {
    await new Promise((done) => server.close(done));
  }
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  assert.equal(dirname(sandbox), resolve(tmpdir()));
  assert.ok(basename(sandbox).startsWith("bytorio archive install "));
  if (report.status === "passed") {
    await rm(sandbox, { recursive: true, force: true });
  }
  console.log(`CLI archive installation ${report.status}: ${output}`);
}
