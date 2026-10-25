import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";
import { chromium } from "./browser-timing.mjs";
import { buildBillboards } from "../examples/billboards/tools/build.mjs";
import { buildEffects } from "../examples/effects/tools/build.mjs";
import { bundleLuau } from "./sdk/bundle.mjs";
import { run, tool, copySdlLibrary, nativeLinkerFlags, nativePlayer } from "./toolchain.mjs";
import { odinUnitTests } from "./odin-unit-tests.mjs";
import { serve } from "./serve.mjs";
import { negotiateProfile } from "../runtime/odin/web/policy.js";
import { RESOURCE_EXPORTS } from "../runtime/odin/web/constants.js";
import { browserEffectProbes } from "./effect-probes.mjs";
import { requireNativePlayer } from "./sdk/project.mjs";
requireNativePlayer();

const gpu = process.argv.includes("--gpu");
const effects = process.argv.includes("--effects");
// Bound sparse perspective-raster differences between native GL and WebGL drivers.
// Independent cutoff/depth probes and CPU/SDK comparisons remain exact.
const GPU_DIFFERENT_PIXELS_PER_LOW_FRAME = 16;
const GPU_MAX_CHANNEL_DELTA = 32;
const root = resolve(
  effects ? "examples/effects/build/validation" : "build/billboard-verification",
  randomUUID(),
);
await mkdir(root, { recursive: true });
const bundleEntry = resolve(root, "bundle.luau");
await writeFile(
  bundleEntry,
  'local byt = require("@bytorio")\nreturn {draw=function() byt.gfx3d.billboard_model({}) end}\n',
);
for (const profile of [1, 2, 3, 4, 5, 6]) {
  const bundled = (
    await bundleLuau({
      entry: bundleEntry,
      project: root,
      sdkRoot: "sdk/luau",
      assets: Buffer.alloc(0),
      profile,
    })
  ).toString();
  assert.equal(bundled.includes('__modules["$sdk/billboard.luau"]'), profile >= 5);
  assert.equal(bundled.includes("This SDK helper requires cartridge profile 5"), profile < 5);
}
const contract = JSON.parse(await readFile("sdk/contract.json"));
const { buttons } = contract;
const profile = JSON.parse(await readFile("sdk/profiles/alpha-3d-preview-1.json"));
const older = JSON.parse(await readFile("sdk/profiles/textured-3d-preview-1.json"));
assert.deepEqual(
  [
    profile.profileId,
    profile.sdkVersionWord,
    profile.abiVersion,
    profile.protocolVersion,
    profile.requiredFeatures,
  ],
  [5, 1280, 2, 7, 63],
);
assert.deepEqual(profile.targets, older.targets);
const advertised = {
  ...Object.fromEntries(RESOURCE_EXPORTS.map(({ name }) => [name, () => 0])),
  game_profile: () => 5,
  game_sdk_version: () => 1280,
  game_abi: () => 2,
  game_resource_protocol: () => 7,
  game_required_features: () => 63,
  game_frame_size: () => 40,
};
assert.equal(negotiateProfile(advertised), 5);
for (const [name, wrong] of [
  ["game_profile", 4],
  ["game_sdk_version", 1024],
  ["game_resource_protocol", 6],
  ["game_required_features", 31],
]) {
  assert.throws(() => negotiateProfile({ ...advertised, [name]: () => wrong }), /Unsupported/);
}
odinUnitTests("tests/3d", resolve(root, "unit.exe"));
if (effects) {
  assert.equal(
    negotiateProfile({
      ...advertised,
      game_profile: () => 6,
      game_sdk_version: () => 1536,
      game_resource_protocol: () => 8,
      game_required_features: () => 127,
    }),
    6,
  );
}
const projects = await (effects ? buildEffects() : buildBillboards());
if (gpu) {
  run(tool("odin"), [
    "build",
    "tests/gpu/native",
    "-o:none",
    `-out:${root}/device.exe`,
    ...nativeLinkerFlags({ harness: true }),
  ]);
  await copySdlLibrary(root);
  assert.equal(JSON.parse(run(resolve(root, "device.exe"), [])).pixel, 0xff0000ff);
}
const server = serve(".", 0);
await once(server, "listening");
const browser = await chromium.launch({
  channel: gpu
    ? process.env.PLAYER_BROWSER_CHANNEL || "chrome"
    : process.env.PLAYER_BROWSER_CHANNEL || undefined,
});
const results = [];
const references = new Map();
try {
  const page = await browser.newPage();
  const settings = gpu
    ? [false, true].flatMap((residentMeshes) =>
        ["off", "2x", "1080p"].map((ssaa) => ({ backend: "gpu", residentMeshes, ssaa })),
      )
    : [{ backend: "cpu", ssaa: "off" }];
  for (const { language, project } of projects) {
    const base = "/" + relative(process.cwd(), resolve(project, "build/web")).replaceAll("\\", "/");
    await page.goto(`http://127.0.0.1:${server.address().port}${base}/player.html`);
    if (effects && gpu) {
      await page.evaluate(browserEffectProbes);
    }
    for (const graphics of settings) {
      for (const [name, mask] of [
        ["still", 0],
        ["orbit", buttons.right],
        ["high", buttons.action],
        ["orbit-high", buttons.action | buttons.left],
      ]) {
        const masks = Array(8).fill(mask);
        const inputs = resolve(root, `${name}.inputs`);
        await writeFile(inputs, masks.join("\n") + "\n");
        const native = JSON.parse(
          run(resolve(project, "build/native", nativePlayer), [
            "--benchmark",
            inputs,
            "--renderer",
            graphics.backend,
            "--ssaa",
            graphics.ssaa,
            ...(graphics.residentMeshes ? ["--gpu-meshes"] : []),
          ]),
        );
        for (const png of gpu || name !== "still" ? [true] : [false, true]) {
          const web = await page.evaluate(
            async ({ base, language, graphics, masks, png, nativeTraces }) => {
              const worker = new Worker(base + "/worker.js", { type: "module" });
              const request = (message, expected) =>
                new Promise((resolve, reject) => {
                  const timer = setTimeout(
                    () => reject(new Error("Billboard worker deadline")),
                    120000,
                  );
                  worker.onerror = (event) => {
                    clearTimeout(timer);
                    reject(new Error(event.message));
                  };
                  worker.onmessage = async ({ data }) => {
                    if (data.type === "executor") {
                      const bytes = await (await fetch(base + "/luau-executor.wasm")).arrayBuffer();
                      worker.postMessage({ type: "executor", executor: { bytes } }, [bytes]);
                    } else if (data.type === "error") {
                      clearTimeout(timer);
                      reject(new Error(data.error));
                    } else if (data.type === expected) {
                      clearTimeout(timer);
                      data.bitmap?.close();
                      resolve(data);
                    }
                  };
                  worker.postMessage(message);
                });
              try {
                const file = png ? "game.png" : language === "luau" ? "game.luau" : "game.wasm";
                const loaded = await request(
                  { type: "load", gameUrl: location.origin + base + "/" + file, graphics },
                  "ready",
                );
                if (loaded.graphics.effective !== graphics.backend) {
                  throw new Error("Requested billboard backend was not selected");
                }
                const result = await request({ type: "benchmark", masks }, "benchmark");
                const capture = await request({ type: "capture" }, "capture");
                result.width = capture.width;
                result.height = capture.height;
                result.differences = [];
                if (graphics.backend === "gpu") {
                  for (let frame = 0; frame < masks.length; frame++) {
                    if (result.traces[frame].hash === nativeTraces[frame].hash) {
                      continue;
                    }
                    await request(
                      { type: "benchmark", masks: masks.slice(0, frame + 1) },
                      "benchmark",
                    );
                    const image = await request({ type: "capture" }, "capture");
                    result.differences.push({
                      frame,
                      pixels: Array.from(new Uint8Array(image.pixels)),
                    });
                  }
                }
                return result;
              } finally {
                worker.terminate();
              }
            },
            { base, language, graphics, masks, png, nativeTraces: native.traces },
          );
          const key = `${name}/${graphics.ssaa}/${Boolean(graphics.residentMeshes)}`;
          assert.deepEqual(
            web.traces.map(({ sounds }) => sounds),
            native.traces.map(({ sounds }) => sounds),
          );
          if (!gpu) {
            assert.deepEqual(
              web.traces,
              native.traces,
              `${language}/${key}: native/browser pixels`,
            );
          }
          assert.equal(web.width, mask & buttons.action ? 640 : 320);
          assert.equal(web.height, mask & buttons.action ? 360 : 180);
          const rasterDifferences = [];
          for (const { frame, pixels } of web.differences) {
            const prefix = resolve(
              root,
              `${language}-${name}-${graphics.ssaa}-${Boolean(graphics.residentMeshes)}-${frame}`,
            );
            await writeFile(prefix + ".inputs", masks.slice(0, frame + 1).join("\n"));
            run(resolve(project, "build/native", nativePlayer), [
              "--replay",
              prefix + ".inputs",
              "--renderer",
              "gpu",
              "--ssaa",
              graphics.ssaa,
              ...(graphics.residentMeshes ? ["--gpu-meshes"] : []),
              "--capture-rgba",
              prefix + "-native.rgba",
            ]);
            const nativePixels = await readFile(prefix + "-native.rgba");
            await writeFile(prefix + "-web.rgba", new Uint8Array(pixels));
            assert.equal(nativePixels.length, pixels.length);
            let differentPixels = 0,
              maxDelta = 0;
            for (let offset = 0; offset < pixels.length; offset += 4) {
              let different = false;
              for (let channel = 0; channel < 4; channel++) {
                const delta = Math.abs(nativePixels[offset + channel] - pixels[offset + channel]);
                maxDelta = Math.max(maxDelta, delta);
                different ||= delta !== 0;
              }
              if (different) {
                differentPixels++;
              }
            }
            const pixelBudget = GPU_DIFFERENT_PIXELS_PER_LOW_FRAME * (web.width / 320) ** 2;
            assert(
              differentPixels <= pixelBudget && maxDelta <= GPU_MAX_CHANNEL_DELTA,
              `${language}/${key}/frame ${frame}: ${differentPixels} different pixels, max delta ${maxDelta}`,
            );
            rasterDifferences.push({ frame, differentPixels, maxDelta });
          }
          if (references.has(key)) {
            assert.deepEqual(web.traces, references.get(key), `${key}: SDK parity`);
          } else {
            references.set(key, web.traces);
          }
          if (gpu) {
            for (const stats of [native.gpuStats, web.gpuStats]) {
              // Native benchmark warmups reset the cartridge eight times.
              const maximumUploads = (effects ? 6 : 4) * 8;
              assert(
                stats.materialUploads > 0 && stats.materialUploads <= maximumUploads,
                JSON.stringify({ language, graphics, name, stats }),
              );
              assert(stats.materialCacheHits > stats.materialUploads);
              if (graphics.residentMeshes) {
                assert(stats.meshUploads > 0 && stats.meshUploads <= 32);
                assert(stats.cacheHits > stats.meshUploads);
              }
            }
          }
          results.push({
            language,
            graphics,
            name,
            png,
            traces: web.traces,
            gpuStats: web.gpuStats,
            rasterDifferences,
          });
        }
      }
    }
    await page.goto(`http://127.0.0.1:${server.address().port}${base}/player.html?game=./game.png`);
    await page.waitForFunction(() => window.playerStatus?.ready || window.playerStatus?.error);
    assert.equal(await page.evaluate(() => window.playerStatus.error), "");
    await page.screenshot({ path: resolve(root, `${language}.png`) });
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
await writeFile(
  resolve(root, "report.json"),
  JSON.stringify({ status: "passed", gpu, cases: results }, null, 2),
);
console.log(
  `${effects ? "Effects" : "Billboards"} passed ${results.length} SDK/host/display/orbit/quality/packaging cases (${gpu ? "GPU" : "CPU"}).`,
);
