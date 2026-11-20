import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep, toNamespacedPath } from "node:path";
import { spawnSync } from "node:child_process";
import { cliPlatforms, requireCliHost } from "./host-platform.mjs";
import { cliReleasePlatform, releaseConfig, verifyReleaseAsset } from "./release-config.mjs";
import { repo } from "./toolchain.mjs";

const backend = "github:ctxshift/bytorio";
const inlineBackend = `${backend}[version_prefix=byt-v,prerelease=true,minimum_release_age=0d]`;
const requested = process.env.BYTORIO_CLI_VERSION ?? "latest";
const expected =
  requested === "latest"
    ? undefined
    : releaseConfig(requested.startsWith("byt-v") ? requested : `byt-v${requested}`).version;
// A fixed published bundle exercises compatibility independently of new SDK releases.
const sdkVersion = process.env.BYTORIO_SDK_VERSION ?? "0.1.0-preview.1";
releaseConfig(`sdk-v${sdkVersion}`);
const host = requireCliHost();
const sandbox = await mkdtemp(join(tmpdir(), "bytorio mise install "));
const reportDirectory = resolve(repo, "build/cli-install-verification", basename(sandbox));
await mkdir(reportDirectory, { recursive: true });
const report = { status: "running", platform: host.id, requested, checks: [] };
const mise = process.env.MISE_BIN || "mise";
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
  // Task discovery also walks canonical Windows paths; bound both spellings.
  MISE_CEILING_PATHS: [sandbox, toNamespacedPath(sandbox)].join(delimiter),
  MISE_TRUSTED_CONFIG_PATHS: sandbox,
  MISE_YES: "1",
  BYTORIO_CACHE_DIR: resolve(sandbox, "sdk-cache"),
});
let command = 0;
async function invoke(args, cwd, env = environment) {
  const result = spawnSync(mise, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 240000,
    windowsHide: true,
  });
  const log = resolve(reportDirectory, `${++command}.log`);
  await writeFile(log, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  assert.ifError(result.error);
  assert.equal(result.status, 0, `mise ${args.join(" ")} failed; see ${log}`);
  return result.stdout.trim();
}
async function manifest(release, platform) {
  const asset = cliReleasePlatform(platform).cliManifest;
  const response = await fetch(
    `https://github.com/ctxshift/bytorio/releases/download/${release.tag}/${asset}`,
    { signal: AbortSignal.timeout(60000) },
  );
  assert.equal(response.status, 200, `${release.tag}/${asset}`);
  return response.json();
}
async function verifyInstalled(directory, env, release) {
  const executable = await invoke(["which", "byt"], directory, env);
  assert.ok(resolve(executable).startsWith(resolve(env.MISE_DATA_DIR) + sep));
  const bytes = await readFile(executable);
  verifyReleaseAsset(release, await manifest(release, host.id), bytes, host.id);
  if (host.windows) {
    assert.equal(bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4), 0x8664);
  } else {
    assert.equal(bytes.readUInt32LE(0), 0xfeedfacf);
    assert.equal(bytes.readUInt32LE(4), host.id === "macos-arm64" ? 0x0100000c : 0x01000007);
  }
  const result = spawnSync(executable, ["--version"], {
    cwd: directory,
    env: { ...env, PATH: "" },
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), release.version);
}

try {
  const consumer = resolve(sandbox, "game workspace");
  await mkdir(consumer);
  const recipe = await readFile(resolve(repo, "install/mise.toml"), "utf8");
  const guide = await readFile(resolve(repo, "docs/getting-started.md"), "utf8");
  const advancedGuide = await readFile(resolve(repo, "docs/mise-installation.md"), "utf8");
  assert.ok(
    advancedGuide.includes(`\`\`\`toml\n${recipe.trim()}\n\`\`\``),
    "Advanced docs contain the tested automatic-update recipe",
  );
  assert.ok(
    advancedGuide.includes(`${inlineBackend}@latest`),
    "Advanced docs contain the tested CLI options",
  );
  const documentedPin = `[tools]\n"${backend}" = "byt-v<version>"\n`;
  assert.ok(guide.includes(documentedPin.trim()), "Getting started uses the short pinned entry");
  await writeFile(
    resolve(consumer, "mise.toml"),
    expected ? recipe.replace('version = "latest"', `version = "${expected}"`) : recipe,
  );
  const configs = JSON.parse(await invoke(["config", "ls", "--json"], consumer));
  assert.equal(configs.length, 1, "Install must not inherit contributor or user configuration");
  assert.deepEqual(configs[0].tools, [backend]);
  await invoke(["install", backend], consumer);
  const version = await invoke(["exec", "--", "byt", "--version"], consumer);
  const release = releaseConfig(`byt-v${version}`);
  if (expected) {
    assert.equal(version, expected);
  }
  report.version = version;
  await verifyInstalled(consumer, environment, release);
  report.checks.push(
    "Fresh [tools] install selects the host binary and matches its published manifest",
  );

  await invoke(["use", "--pin", `${backend}@${expected ?? "latest"}`], consumer);
  assert.ok(
    (await readFile(resolve(consumer, "mise.toml"), "utf8")).includes(`version = "${version}"`),
  );
  await invoke(["lock", "--platform", cliPlatforms.join(","), backend], consumer);
  const lock = await readFile(resolve(consumer, "mise.lock"), "utf8");
  for (const platform of cliPlatforms) {
    const section = lock.split(`[tools."${backend}"."platforms.${platform}"]`)[1]?.split(/\n\[/)[0];
    assert.ok(section, `Lock contains ${platform}`);
    const entry = await manifest(release, platform);
    const selected = entry.archive ?? entry;
    assert.ok(section.includes(`/releases/download/${release.tag}/${selected.asset}"`));
    assert.ok(section.includes(`checksum = "sha256:${selected.sha256}"`));
  }
  await writeFile(resolve(reportDirectory, "mise.lock"), lock);
  report.checks.push(
    "Pinned cross-platform lock contains each platform's correct URL and checksum",
  );

  const locked = { ...environment, MISE_DATA_DIR: resolve(sandbox, "locked-data") };
  await invoke(["install", "--locked", backend], consumer, locked);
  await verifyInstalled(consumer, locked, release);
  report.checks.push(
    "Locked reinstall into a clean installation directory preserves the tested binary",
  );

  await invoke(["run", "sdk:install", "--", sdkVersion], consumer);
  assert.equal(
    (await readdir(resolve(environment.MISE_DATA_DIR, "installs"), { withFileTypes: true })).filter(
      (entry) => entry.isDirectory(),
    ).length,
    1,
    "SDK task must not install contributor or unrelated global tools",
  );
  const cached = JSON.parse(
    await readFile(resolve(environment.BYTORIO_CACHE_DIR, "sdk", sdkVersion, "entry.json"), "utf8"),
  );
  assert.equal(
    createHash("sha256").update(Buffer.from(cached.archive, "base64")).digest("hex"),
    cached.manifest.sha256,
  );
  for (const language of ["luau", "odin"]) {
    const project = `offline ${language} game`;
    await invoke(
      [
        "exec",
        "--",
        "byt",
        "new",
        project,
        "--language",
        language,
        "--sdk",
        sdkVersion,
        "--offline",
      ],
      consumer,
    );
    const pinned = JSON.parse(await readFile(resolve(consumer, project, "byt.lock.json"), "utf8"));
    assert.deepEqual(pinned.sdk, { version: sdkVersion, sha256: cached.manifest.sha256 });
  }
  report.checks.push(
    "SDK mise task caches a verified bundle for offline scaffolding in both languages",
  );

  const cli = resolve(sandbox, "CLI configuration");
  await mkdir(cli);
  const cliEnvironment = { ...environment, MISE_DATA_DIR: resolve(sandbox, "cli-data") };
  await invoke(["use", "--pin", `${inlineBackend}@${expected ?? "latest"}`], cli, cliEnvironment);
  await verifyInstalled(cli, cliEnvironment, release);
  report.checks.push("Documented mise use command installs and records the same release");

  const pinned = resolve(sandbox, "pinned configuration");
  await mkdir(pinned);
  await writeFile(
    resolve(pinned, "mise.toml"),
    documentedPin.replace("byt-v<version>", release.tag),
  );
  const pinnedEnvironment = { ...environment, MISE_DATA_DIR: resolve(sandbox, "pinned-data") };
  await invoke(["install", backend], pinned, pinnedEnvironment);
  await verifyInstalled(pinned, pinnedEnvironment, release);
  report.checks.push("One-line full-tag pin works with mise defaults and exposes the byt command");
  if ((await manifest(release, host.id)).status === "standalone-authoring-preview") {
    const installed = await invoke(["which", "byt"], consumer);
    const result = spawnSync(
      process.execPath,
      [resolve(repo, "tools/verify-published-authoring.mjs"), installed],
      {
        cwd: sandbox,
        env: environment,
        encoding: "utf8",
        timeout: 600000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
    );
    await writeFile(
      resolve(reportDirectory, "published-authoring.log"),
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, "Published authoring failed; see published-authoring.log");
    report.checks.push(
      "Installed CLI creates, checks, builds, packs and plays using published SDK components without source tools",
    );
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  throw error;
} finally {
  await writeFile(resolve(reportDirectory, "report.json"), JSON.stringify(report, null, 2));
  // Only this verifier's temporary tree is eligible for recursive cleanup.
  assert.equal(dirname(sandbox), resolve(tmpdir()));
  assert.ok(basename(sandbox).startsWith("bytorio mise install "));
  if (report.status === "passed") {
    await rm(sandbox, { recursive: true, force: true });
  }
  console.log(`CLI installation ${report.status}: ${reportDirectory}`);
}
