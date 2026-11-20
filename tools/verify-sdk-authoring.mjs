import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { requireCliHost } from "./host-platform.mjs";
import { repo } from "./toolchain.mjs";
import { produceHostSdk } from "./sdk/produce.mjs";
import { assembleSdk } from "./sdk/assemble.mjs";
import { chromium } from "./browser-timing.mjs";
import { serve } from "./serve.mjs";
import { bindPlayer } from "./browser-player.mjs";
import { parseSdkManifest } from "./cli/sdk-manifest.mjs";

const host = requireCliHost();
const output = resolve(repo, "build/sdk-authoring-verification");
await mkdir(output, { recursive: true });
await rm(resolve(output, "report.json"), { force: true });
const built = resolve(repo, "build/cli", host.executable);
const temporaryRoot = resolve(tmpdir());
const sandbox = await mkdtemp(resolve(temporaryRoot, "byt-authoring-consumer-"));
assert.ok(sandbox.startsWith(temporaryRoot + sep));
const server = createServer();
const execute = promisify(execFile);
let browser, website, running;
try {
  const external = process.env.BYTORIO_SDK_DIRECTORY;
  const produced = external
    ? null
    : await produceHostSdk({
        version: "0.2.0-preview.1",
        cliVersionRange: ">=0.2.0-0 <0.3.0",
        output: resolve(sandbox, "SDK candidate"),
      });
  const {
    manifest,
    metadata,
    output: assembled,
  } = external
    ? {
        output: resolve(external),
        metadata: await readFile(resolve(external, "sdk-release.json")),
        manifest: parseSdkManifest(await readFile(resolve(external, "sdk-release.json"))),
      }
    : await assembleSdk({
        candidates: [{ host: host.id, directory: produced.output }],
        canonicalHost: host.id,
        output: resolve(sandbox, "assembled SDK release"),
      });
  const archives = new Map(
    Object.values(manifest.components).map(({ asset }) => [asset, resolve(assembled, asset)]),
  );
  const languages = Object.keys(manifest.languages).filter(
    (language) => manifest.languages[language].hosts[host.id],
  );
  const nativeSupported = Boolean(manifest.native[host.id]);
  assert.ok(languages.includes("luau"));
  if (host.supported) {
    assert.ok(languages.includes("odin"));
    assert.ok(nativeSupported);
  }
  const targets = nativeSupported ? ["web", "native"] : ["web"];
  if (produced) {
    await assert.rejects(
      produceHostSdk({
        version: manifest.version,
        cliVersionRange: manifest.cliVersionRange,
        output: resolve(sandbox, "SDK candidate"),
      }),
      { code: "EEXIST" },
    );
  }
  const metadataSha256 = createHash("sha256").update(metadata).digest("hex");
  const requests = [];
  server.on("request", async (request, response) => {
    requests.push(request.url);
    const name = new URL(request.url, "http://127.0.0.1").pathname.split("/").at(-1);
    if (name === "sdk-release.json") {
      response.end(metadata);
    } else if (archives.has(name)) {
      response.end(await readFile(archives.get(name)));
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const executable = resolve(sandbox, host.executable);
  await copyFile(built, executable);
  const cache = resolve(sandbox, "shared SDK cache");
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(path|mise.*|node.*|bun.*|odin.*|validation_.*)$/i.test(name),
    ),
  );
  environment.PATH = "";
  environment.ODIN_ROOT = resolve(sandbox, "unrelated compiler root");
  environment.BYTORIO_CACHE_DIR = cache;
  environment.BYTORIO_SDK_RELEASE_ROOT = `http://127.0.0.1:${server.address().port}`;
  const cliEnvironment = {
    ...environment,
    SDL_VIDEODRIVER: "dummy",
    SDL_AUDIODRIVER: "dummy",
    SDL_RENDER_DRIVER: "software",
  };
  async function invoke(language, action, { offline = false, targets = ["web"] } = {}) {
    const args = [action, resolve(sandbox, `${language} game`)];
    if (offline) {
      args.push("--offline");
    }
    if (action === "build" && targets.length > 1) {
      args.push("--target", "all");
    }
    const result = await execute(executable, args, {
      cwd: sandbox,
      env: cliEnvironment,
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });
    assert.match(result.stdout, /Checked|Built|Packed/);
    return result;
  }
  for (const language of languages) {
    const project = resolve(sandbox, `${language} game`);
    await execute(executable, ["new", project, "--language", language, "--sdk", manifest.version], {
      cwd: sandbox,
      env: cliEnvironment,
      windowsHide: true,
      timeout: 30000,
    });
  }
  assert.ok(!requests.some((path) => path.endsWith(".tar.gz")), "New downloaded SDK payloads");
  const configuredProject = resolve(sandbox, "luau game/bytorio.toml");
  await writeFile(
    configuredProject,
    (await readFile(configuredProject, "utf8")) +
      '\n[player]\ninstructions="Arrows move. Space jumps."\n[player.controls]\nvisibility="always"\n[player.controls.overrides.action]\nlabel="Jump"\n',
  );
  await invoke("luau", "check");
  assert.ok(
    !requests.some((path) => path.endsWith(manifest.components.web.asset)),
    "Checking downloaded the web player",
  );
  const odinId = `odin-${host.id}`;
  const nativeId = `native-${host.id}`;
  assert.ok(
    !requests.some(
      (path) => manifest.components[odinId] && path.endsWith(manifest.components[odinId].asset),
    ),
  );
  assert.ok(
    !requests.some(
      (path) => manifest.components[nativeId] && path.endsWith(manifest.components[nativeId].asset),
    ),
  );
  const checkedRequests = requests.length;
  await invoke("luau", "pack", { offline: true });
  assert.equal(requests.length, checkedRequests);
  await invoke("luau", "build");
  assert.equal(requests.filter((path) => path.endsWith(manifest.components.web.asset)).length, 1);
  assert.ok(
    !requests.some(
      (path) => manifest.components[odinId] && path.endsWith(manifest.components[odinId].asset),
    ),
  );
  assert.ok(
    !requests.some(
      (path) => manifest.components[nativeId] && path.endsWith(manifest.components[nativeId].asset),
    ),
  );
  if (languages.includes("odin")) {
    await invoke("odin", "check");
    const odinCheckedRequests = requests.length;
    await invoke("odin", "pack", { offline: true });
    assert.equal(requests.length, odinCheckedRequests);
  }
  for (const language of languages) {
    await invoke(language, "build", { targets });
  }
  const builtRequests = requests.length;
  for (const language of languages) {
    await invoke(language, "build", { offline: true, targets });
  }
  assert.equal(requests.length, builtRequests);
  // Target changes and cartridge-only publication keep each older export whole.
  const retentionProject = resolve(sandbox, "luau game");
  const originalWeb = await readFile(resolve(retentionProject, "build/web/game.png"));
  const originalNative = nativeSupported
    ? await readFile(resolve(retentionProject, "build/native/game.png"))
    : null;
  const entry = resolve(retentionProject, "src/main.luau");
  await writeFile(entry, (await readFile(entry, "utf8")) + "\n-- changed cartridge revision\n");
  const webOnly = await invoke("luau", "build", { offline: true });
  const updatedWeb = await readFile(resolve(retentionProject, "build/web/game.png"));
  assert.notDeepEqual(updatedWeb, originalWeb);
  if (nativeSupported) {
    assert.match(webOnly.stdout, /Kept native export unchanged.*--target native/);
    assert.deepEqual(
      await readFile(resolve(retentionProject, "build/native/game.png")),
      originalNative,
    );
    await execute(executable, ["build", retentionProject, "--offline", "--target", "native"], {
      cwd: sandbox,
      env: cliEnvironment,
      windowsHide: true,
      timeout: 120000,
    });
    assert.deepEqual(await readFile(resolve(retentionProject, "build/web/game.png")), updatedWeb);
  }
  const packed = await invoke("luau", "pack", { offline: true });
  assert.match(packed.stdout, /Kept web export unchanged.*--target web/);
  assert.deepEqual(await readFile(resolve(retentionProject, "build/web/game.png")), updatedWeb);
  await assert.rejects(
    execute(
      executable,
      [
        "pack",
        retentionProject,
        "--offline",
        "--output",
        resolve(retentionProject, "build/web/game.png"),
      ],
      {
        cwd: sandbox,
        env: cliEnvironment,
        windowsHide: true,
        timeout: 30000,
      },
    ),
    /cannot overwrite a player export/,
  );
  const outputAlias = resolve(sandbox, "output alias");
  await symlink(retentionProject, outputAlias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    execute(
      executable,
      [
        "pack",
        retentionProject,
        "--offline",
        "--output",
        resolve(outputAlias, "build/web/new/game.png"),
      ],
      {
        cwd: sandbox,
        env: cliEnvironment,
        windowsHide: true,
        timeout: 120000,
      },
    ),
    /cannot overwrite a player export/,
  );
  // An unsuccessful edit must leave the last complete public export intact.
  const luau = resolve(sandbox, "luau game");
  const prior = await readFile(resolve(luau, "build/web/game.png"));
  await writeFile(resolve(luau, "src/main.luau"), "this is not valid Luau !");
  await assert.rejects(invoke("luau", "build", { offline: true }));
  assert.deepEqual(await readFile(resolve(luau, "build/web/game.png")), prior);
  await writeFile(resolve(luau, "src/main.luau"), manifest.starters.luau.source);
  running = spawn(executable, ["dev", luau, "--offline", "--no-open"], {
    cwd: sandbox,
    env: cliEnvironment,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const playerUrl = await new Promise((done, reject) => {
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => reject(new Error(`CLI run did not start: ${stderr}`)), 60000);
    running.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    running.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = /Player: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        done(match[1]);
      }
    });
    running.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    running.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`CLI run exited: ${stderr}`));
    });
  });
  browser = await chromium.launch({ channel: process.env.PLAYER_BROWSER_CHANNEL || undefined });
  const preview = await browser.newPage();
  await preview.goto(`${playerUrl}?smoke`);
  await bindPlayer(preview);
  await preview.waitForFunction(() => window.hostedPlayer.runtime.getSnapshot().ready);
  assert.equal(await preview.evaluate(() => "playerStatus" in window), false);
  await preview.getByRole("button", { name: "Play game", exact: true }).click();
  assert.equal(await preview.getByRole("button", { name: "Jump", exact: true }).isVisible(), true);
  await preview.waitForFunction(
    () => window.hostedPlayer.runtime.getSnapshot().renderedTicks >= 120,
  );
  assert.equal(
    await preview.evaluate(async () => window.hostedPlayer.runtime.getSnapshot().error),
    "",
  );
  const initialUrl = preview.url();
  await writeFile(resolve(luau, "src/main.luau"), "this is not valid Luau !");
  // Wait for the failed build diagnostic, then recover through the same watcher.
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Dev did not report the failed edit")), 30000);
    const receive = (chunk) => {
      if (String(chunk).includes("Waiting for another edit")) {
        clearTimeout(timer);
        running.stderr.removeListener("data", receive);
        done();
      }
    };
    running.stderr.on("data", receive);
  });
  assert.equal(preview.url(), initialUrl);
  const reloaded = preview.waitForURL((url) => url.href !== initialUrl, { timeout: 60000 });
  await writeFile(resolve(luau, "src/main.luau"), manifest.starters.luau.source + "\n-- edited\n");
  await reloaded;
  await bindPlayer(preview);
  await preview.waitForFunction(() => window.hostedPlayer.runtime.getSnapshot().ready);
  assert.equal(
    await preview.evaluate(async () => window.hostedPlayer.runtime.getSnapshot().error),
    "",
  );
  await preview.close();
  const stopped = new Promise((done) => running.once("exit", done));
  running.kill("SIGTERM");
  await stopped;
  running = null;
  // Run exported native cartridges through the public CLI's explicit target.
  for (const language of nativeSupported ? languages : []) {
    const result = await execute(
      executable,
      [
        "run",
        resolve(sandbox, `${language} game`),
        "--offline",
        "--target",
        "native",
        "--",
        "--smoke",
        "--no-executor-cache",
      ],
      { cwd: sandbox, env: cliEnvironment, windowsHide: true, timeout: 60000 },
    );
    const frame = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(frame.ticks, 120);
    await invoke(language, "build", { offline: true, targets: ["web", "native"] });
  }
  await mkdir(resolve(sandbox, "site/nested"), { recursive: true });
  for (const language of languages) {
    const project = resolve(sandbox, `${language} game`);
    await rename(resolve(project, "build/web"), resolve(sandbox, `site/nested/${language}`));
    if (nativeSupported) {
      await rename(resolve(project, "build/native"), resolve(sandbox, `${language} native export`));
    }
  }
  assert.ok(cache.startsWith(sandbox + sep));
  await rm(cache, { recursive: true, force: true });
  website = serve(resolve(sandbox, "site"), 0);
  await new Promise((done) => website.once("listening", done));
  const played = {};
  for (const language of languages) {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${website.address().port}/nested/${language}/player.html`);
    await bindPlayer(page);
    await page.waitForFunction(() => window.hostedPlayer.runtime.getSnapshot().ready);
    await page.getByRole("button", { name: "Play game", exact: true }).click();
    await page.waitForFunction(() => window.hostedPlayer.runtime.getSnapshot().ticks > 5);
    assert.equal(await page.evaluate(() => "playerStatus" in window), false);
    await page.goto(
      `http://127.0.0.1:${website.address().port}/nested/${language}/custom-player.html`,
    );
    await page.evaluate(async () => {
      window.customHost = await import("./custom-player.js");
      await window.customHost.ready;
    });
    await page.waitForFunction(() => window.customHost.runtime.getSnapshot().ready);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForFunction(() => window.customHost.runtime.getSnapshot().ticks > 5);
    await page.evaluate(() => window.customHost.dispose());
    await page.goto(
      `http://127.0.0.1:${website.address().port}/nested/${language}/debug.html?smoke`,
    );
    await page.waitForFunction(() => playerStatus.ready || playerStatus.error);
    await page.click("#start");
    await page.waitForFunction(() => playerStatus.renderedTicks === 120 || playerStatus.error);
    const web = await page.evaluate(() => ({
      error: playerStatus.error,
      ticks: playerStatus.ticks,
      hash: playerStatus.hash,
    }));
    assert.equal(web.error, "");
    assert.equal(web.ticks, 120);
    await page.close();
    let native;
    if (nativeSupported) {
      const target = resolve(sandbox, `${language} native export`);
      const result = await execute(
        resolve(target, host.player),
        ["--smoke", "--no-executor-cache"],
        {
          cwd: sandbox,
          env: {
            ...environment,
            SDL_VIDEODRIVER: "dummy",
            SDL_AUDIODRIVER: "dummy",
            SDL_RENDER_DRIVER: "software",
          },
          windowsHide: true,
          timeout: 60000,
        },
      );
      native = JSON.parse(result.stdout);
      assert.equal(native.ticks, 120);
      assert.ok(native.audioQueuedFrames > 0);
      assert.equal(native.hash, web.hash, `${language} relocated native/web starter image`);
      if (process.platform === "darwin") {
        for (const name of [host.player, host.sdlLibrary]) {
          await execute("/usr/bin/codesign", ["--verify", "--strict", resolve(target, name)], {
            cwd: sandbox,
            env: environment,
            timeout: 30000,
          });
        }
      }
    }
    played[language] = { web, native };
  }
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        status: "passed",
        platform: host.id,
        isolatedCwd: true,
        emptyPath: true,
        metadataSha256,
        checkedRequests,
        builtRequests,
        offlinePack: true,
        offlineBuild: true,
        publicCli: true,
        browserDev: true,
        failedEditRecovery: true,
        nativeRun: nativeSupported,
        languages,
        assembledRelease: Boolean(external),
        failedBuildPreservesOutput: true,
        relocatedPlaybackWithoutCache: true,
        played,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Standalone SDK authoring passed: public new/check/build/pack/run, managed Luau/Odin tools, offline reuse and relocated native/browser play without cache.",
  );
} finally {
  running?.kill("SIGKILL");
  await browser?.close();
  await new Promise((done) => (website ? website.close(done) : done()));
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await rm(sandbox, { recursive: true, force: true });
}
