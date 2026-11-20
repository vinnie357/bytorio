import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { requireCliHost } from "./host-platform.mjs";
import { chromium } from "./browser-timing.mjs";
import { repo } from "./toolchain.mjs";
import { bindPlayer } from "./browser-player.mjs";

const [installed] = process.argv.slice(2);
if (!installed) {
  throw new Error("Expected an installed CLI executable");
}
const host = requireCliHost();
const root = await mkdtemp(resolve(tmpdir(), "byt-published-authoring-"));
const executable = resolve(root, host.executable);
const execute = promisify(execFile);
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(path|mise.*|node.*|bun.*|odin.*|bytorio.*|validation_.*)$/i.test(key),
  ),
);
Object.assign(environment, {
  PATH: "",
  BYTORIO_CACHE_DIR: resolve(root, "cache"),
  SDL_VIDEODRIVER: "dummy",
  SDL_AUDIODRIVER: "dummy",
  SDL_RENDER_DRIVER: "software",
});
let browser, player;
const games = [];
try {
  await copyFile(resolve(installed), executable);
  for (const language of host.supported ? ["luau", "odin"] : ["luau"]) {
    const project = resolve(root, `${language} game`);
    const invoke = (...args) =>
      execute(executable, args, {
        cwd: root,
        env: environment,
        timeout: 180000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
    await invoke("new", project, "--language", language);
    const pin = await readFile(resolve(project, "bytorio.lock.toml"), "utf8");
    await invoke("check", project);
    await invoke("build", project);
    await invoke("pack", project, "--offline");
    await invoke("build", project, "--offline");
    player = spawn(executable, ["run", project, "--offline", "--no-open"], {
      cwd: root,
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const url = await new Promise((done, reject) => {
      let output = "";
      let error = "";
      const timer = setTimeout(
        () => reject(new Error(`Published CLI did not serve a game: ${error}`)),
        60000,
      );
      player.stdout.on("data", (chunk) => {
        output += chunk;
        const match = /Player: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
        if (match) {
          clearTimeout(timer);
          done(match[1]);
        }
      });
      player.stderr.on("data", (chunk) => {
        error += chunk;
      });
      player.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      player.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`Published CLI exited: ${error}`));
      });
    });
    browser ??= await chromium.launch({ channel: process.env.PLAYER_BROWSER_CHANNEL || undefined });
    const page = await browser.newPage();
    const production = (await fetch(new URL("bootstrap.js", url))).ok;
    if (production) {
      await page.goto(url);
      await bindPlayer(page);
      await page.waitForFunction(() => window.hostedPlayer.runtime.getSnapshot().ready);
      await page.getByRole("button", { name: "Play game", exact: true }).click();
      await page.waitForFunction(() => window.hostedPlayer.runtime.getSnapshot().ticks > 5);
      assert.equal(await page.evaluate(() => "playerStatus" in window), false);
    }
    await page.goto(`${url}${production ? "debug.html" : ""}?smoke`);
    await page.waitForFunction(() => playerStatus.ready || playerStatus.error);
    await page.click("#start");
    await page.waitForFunction(() => playerStatus.renderedTicks === 120 || playerStatus.error);
    assert.equal(await page.evaluate(() => playerStatus.error), "");
    const hash = await page.evaluate(() => playerStatus.hash);
    await page.close();
    const stopped = once(player, "exit");
    player.kill("SIGTERM");
    await stopped;
    player = null;
    if (host.supported) {
      const { stdout } = await invoke(
        "run",
        project,
        "--target",
        "native",
        "--",
        "--smoke",
        "--no-executor-cache",
      );
      const native = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
      assert.equal(native.ticks, 120);
      assert.equal(native.hash, hash);
    }
    assert.equal(await readFile(resolve(project, "bytorio.lock.toml"), "utf8"), pin);
    games.push({ language, hash, exactPin: pin });
  }
  const output = resolve(repo, "build/published-authoring-verification");
  await mkdir(output, { recursive: true });
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      { status: "passed", host: host.id, emptyPath: true, publishedDownloads: true, games },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Published CLI/SDK authoring passed on ${host.id}: ${games.map(({ language }) => language).join(", ")}`,
  );
} finally {
  player?.kill("SIGKILL");
  await browser?.close();
  await rm(root, { recursive: true, force: true });
}
