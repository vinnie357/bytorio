import { nativePlayer } from "./toolchain.mjs";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { timedSpawnSync as spawnSync } from "./command-timing.mjs";
import { once } from "node:events";
import { cpus, platform, arch } from "node:os";
import { chromium } from "./browser-timing.mjs";
import { build3dExamples } from "./build-3d.mjs";
import { odinUnitTests } from "./odin-unit-tests.mjs";
import { serve } from "./serve.mjs";
import { bindPlayer } from "./browser-player.mjs";
import { negotiateProfile } from "../runtime/odin/web/policy.js";
import { resourceSchema } from "../runtime/odin/web/constants.js";
import { requireNativePlayer } from "./sdk/project.mjs";
requireNativePlayer();

const profile = JSON.parse(await readFile("sdk/profiles/compact-3d-preview-1.json"));
const baseProfile = JSON.parse(await readFile("sdk/profiles/resource-av-1.json"));
const contract = JSON.parse(await readFile("sdk/contract.json"));
const advertised = contract.profiles.find((item) => item.id === profile.profileId);
assert.deepEqual(
  [profile.sdkVersionWord, profile.abiVersion, profile.protocolVersion, profile.requiredFeatures],
  [advertised.sdkWord, advertised.abi, advertised.protocol, advertised.features],
);
for (const [name, value] of Object.entries(baseProfile.targets)) {
  assert.equal(profile.targets[name], value);
}
for (const name of [
  "maxMeshVertices",
  "maxMeshIndices",
  "maxTrianglesPerCommit",
  "maxVoxelAxis",
  "maxVoxelFaces",
  "maxVoxelCellsPerCommit",
  "maxPixelWork",
]) {
  assert.equal(profile.targets[name], resourceSchema[name]);
}

assert.throws(
  () =>
    negotiateProfile({ game_profile: () => 1, game_abi: () => 1, game_resource_protocol: () => 5 }),
  /explicit cartridge profile/,
);

const root = resolve("build/compact-3d");
await mkdir(root, { recursive: true });
const env = {
  ...process.env,
  SDL_VIDEODRIVER: "dummy",
  SDL_AUDIODRIVER: "dummy",
  SDL_RENDER_DRIVER: "software",
};
function run(exe, args, options = {}) {
  const output = spawnSync(exe, args, {
    encoding: "utf8",
    env,
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  assert.ifError(output.error);
  assert.equal(output.status, 0, output.stderr + output.stdout);
  return output.stdout;
}
odinUnitTests("tests/3d", resolve(root, "renderer-tests.exe"));
const projects = await build3dExamples(root);
const cases = [
  ["scene", 0],
  ["edit", 8],
  ["checkerboard", 4],
  ["instances", 1],
  ["perspective", 2],
].flatMap(([name, mask]) => [
  { name: `${name}-320`, mask, width: 320, height: 180 },
  { name: `${name}-640`, mask: mask | 16, width: 640, height: 360 },
]);
const frames = 24;
const results = [];
const server = serve(".", 0);
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const quantile = (values, q) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))];
function summary(measured) {
  const totals = measured.timings.map((row) => row.slice(0, 3).reduce((a, b) => a + b, 0));
  const updates = measured.timings.map((row) => row[0]);
  return {
    samples: totals.length,
    cpuP50Ms: quantile(totals, 0.5),
    cpuP95Ms: quantile(totals, 0.95),
    updateP50Ms: quantile(updates, 0.5),
    updateP95Ms: quantile(updates, 0.95),
    startup: measured.startup,
    memory: measured.memory,
    resourceStats: measured.resourceStats,
  };
}
try {
  browser = await chromium.launch({ channel: process.env.PLAYER_BROWSER_CHANNEL || undefined });
  for (const { language, project } of projects) {
    const executable = resolve(project, "build/native", nativePlayer);
    const native = (args) => JSON.parse(run(executable, args));
    const base = "/" + relative(process.cwd(), resolve(project, "build/web")).replaceAll("\\", "/");
    const page = await browser.newPage({ viewport: { width: 960, height: 650 } });
    // Verify the packaged cartridge through the full interactive player as well.
    await page.goto(`${origin}${base}/debug.html?game=./game.png&smoke`);
    await page.waitForFunction(() => window.playerStatus?.ready || window.playerStatus?.error);
    assert.equal(await page.evaluate(() => window.playerStatus.error), "");
    const cold = await page.evaluate(() => ({
      startup: window.playerStatus.startup,
      memory: window.playerStatus.memory,
    }));
    await page.locator("#start").click();
    await page.waitForFunction(() => window.playerStatus.ticks >= 120 || window.playerStatus.error);
    assert.equal(await page.evaluate(() => window.playerStatus.error), "");
    const smoke = native(["--smoke"]);
    assert.equal(
      await page.evaluate(() => window.playerStatus.hash),
      smoke.hash,
      `${language} packaged player pixels`,
    );
    await page.screenshot({ path: resolve(root, `${language}-player.png`) });
    const png = await readFile(resolve(project, "build/game.png"));
    await page.evaluate(() => {
      window.playerStatus.ready = false;
      window.playerStatus.error = "";
    });
    await page
      .locator("#cartridge")
      .setInputFiles({ name: "reload.png", mimeType: "image/png", buffer: png });
    await page.waitForFunction(() => window.playerStatus.ready || window.playerStatus.error);
    assert.equal(await page.evaluate(() => window.playerStatus.error), "");
    const warm = await page.evaluate(() => ({
      startup: window.playerStatus.startup,
      memory: window.playerStatus.memory,
    }));
    if (language === "luau") {
      assert.equal(warm.startup.executorCache.hit, true);
    }
    // Use the player's actual Worker protocol to retain transfer and validation costs.
    await page.goto(`${origin}${base}/debug.html`);
    const measured = await page.evaluate(
      async ({ base, language, cases, frames }) => {
        const worker = new Worker(base + "/worker.js", { type: "module" });
        const request = (message, expected) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              worker.terminate();
              reject(new Error("3D Worker deadline"));
            }, 180000);
            worker.onerror = (event) => {
              clearTimeout(timer);
              reject(new Error(event.message));
            };
            worker.onmessage = ({ data }) => {
              if (data.type === "error") {
                clearTimeout(timer);
                reject(new Error(data.error));
              } else if (data.type === expected) {
                clearTimeout(timer);
                resolve(data);
              }
            };
            worker.postMessage(message);
          });
        const output = [];
        try {
          for (const scenario of cases) {
            await request(
              {
                type: "load",
                gameUrl:
                  location.origin + base + (language === "luau" ? "/game.luau" : "/game.wasm"),
              },
              "ready",
            );
            const record = await request(
              { type: "benchmark", masks: Array(frames).fill(scenario.mask) },
              "benchmark",
            );
            output.push({ name: scenario.name, ...record });
          }
        } finally {
          worker.terminate();
        }
        return output;
      },
      { base, language, cases, frames },
    );
    const record = { language, loads: { browser: { cold, warm } }, cases: [] };
    for (const [index, scenario] of cases.entries()) {
      const inputs = resolve(root, `${scenario.name}.inputs`);
      await writeFile(inputs, Array(frames).fill(String(scenario.mask)).join("\n") + "\n");
      const local = native(["--benchmark", inputs]);
      const web = measured[index];
      assert.equal(local.timings.length, frames * 5);
      assert.equal(web.timings.length, frames * 5);
      assert.deepEqual(
        web.traces,
        local.traces,
        `${language}/${scenario.name} native/browser frame hashes`,
      );
      for (const key of [
        "triangles",
        "voxelCells",
        "voxelFaces",
        "voxelRebuilds",
        "sourceBytes",
        "geometryBytes",
        "depthBytes",
        "currentResourceBytes",
      ]) {
        assert.equal(
          web.resourceStats[key],
          local.resourceStats[key],
          `${language}/${scenario.name}/${key}`,
        );
      }
      assert.equal(
        local.resourceStats.voxelRebuilds,
        scenario.name.startsWith("edit") ? frames + 5 : 5,
      );
      if (results.length) {
        assert.deepEqual(
          local.traces,
          results[0].cases[index].traces,
          `${scenario.name} SDK equivalence`,
        );
      }
      record.cases.push({
        name: scenario.name,
        mask: scenario.mask,
        traces: local.traces,
        native: summary(local),
        browser: summary(web),
      });
      // Retain raw samples separately from the concise report.
      await writeFile(
        resolve(root, `${language}-${scenario.name}.json`),
        JSON.stringify({ native: local, browser: web }, null, 2) + "\n",
      );
      console.log(
        `${language}/${scenario.name}: native ${summary(local).cpuP95Ms.toFixed(2)} ms, browser ${summary(web).cpuP95Ms.toFixed(2)} ms p95`,
      );
    }
    const inputs = resolve(root, "scene-320.inputs");
    record.loads.native = {
      uncached: native(["--benchmark", inputs, "--no-executor-cache"]).startup,
      cached: native(["--benchmark", inputs]).startup,
    };
    await page.close();
    results.push(record);
  }
  const comparison = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await comparison.goto(
    `${origin}/${relative(process.cwd(), root).replaceAll("\\", "/")}/player.html`,
  );
  for (const frame of comparison.frames().slice(1)) {
    await bindPlayer(frame);
    await frame.waitForFunction(
      () =>
        window.hostedPlayer.runtime.getSnapshot().ready ||
        window.hostedPlayer.runtime.getSnapshot().error,
    );
    assert.equal(await frame.evaluate(() => window.hostedPlayer.runtime.getSnapshot().error), "");
  }
  assert.equal(comparison.frames().length, 3);
  await comparison.screenshot({ path: resolve(root, "comparison.png"), fullPage: true });
  await comparison.close();
  await writeFile(
    resolve(root, "report.json"),
    JSON.stringify(
      {
        environment: {
          platform: platform(),
          arch: arch(),
          cpu: cpus()[0].model,
          browser: browser.version(),
        },
        frames,
        method:
          "Five measured passes after two warm-up passes; CPU excludes presentation/audio output. Both published display modes; exact framebuffer hashes and matching resource accounting.",
        results,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
console.log(
  "3D passed: mesh/depth/clipping, voxel edits, both SDKs, standalone PNG players and browser Worker benchmarks. Report: build/compact-3d/report.json",
);
