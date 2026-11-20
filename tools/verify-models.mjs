import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";
import { chromium } from "playwright";
import { buildModels } from "../examples/models/tools/build.mjs";
import { serve } from "./serve.mjs";
import { run, nativePlayer } from "./toolchain.mjs";
import { requireNativePlayer } from "./sdk/project.mjs";
requireNativePlayer();

const gpu = process.argv.includes("--gpu");
const root = resolve("build/model-verification", randomUUID());
await mkdir(root, { recursive: true });
const projects = await buildModels();
const opaque = JSON.parse(await readFile("examples/models/assets/rigid-kart.gltf"));
for (const material of opaque.materials) {
  material.alphaMode = "OPAQUE";
}
const opaqueFile = resolve(root, "opaque.gltf");
await writeFile(opaqueFile, JSON.stringify(opaque));
const opaqueProjects = await buildModels("examples/models/build/opaque", opaqueFile);
const server = serve(".", 0);
await once(server, "listening");
const browser = await chromium.launch({
  channel: process.env.PLAYER_BROWSER_CHANNEL || (gpu ? "chrome" : undefined),
});
const cases = [];
const references = new Map();
try {
  const page = await browser.newPage();
  for (const { language, project, variant } of [
    ...projects.map((project) => ({ ...project, variant: "masked" })),
    ...opaqueProjects.map((project) => ({ ...project, variant: "opaque" })),
  ]) {
    const base = "/" + relative(process.cwd(), resolve(project, "build/web")).replaceAll("\\", "/");
    await page.goto(`http://127.0.0.1:${server.address().port}${base}/debug.html`);
    for (const residentMeshes of gpu ? [false, true] : [false]) {
      const graphics = { backend: gpu ? "gpu" : "cpu", ssaa: "off", residentMeshes };
      for (const [name, masks] of [
        ["still", Array(8).fill(0)],
        ["turn", Array(8).fill(2)],
        ["high", Array(8).fill(16)],
        ["high-turn", Array(8).fill(18)],
        ["release-recreate", [8, 8, 8, 0, 0, 0, 2, 2]],
      ]) {
        const inputs = resolve(root, `${name}.inputs`);
        await writeFile(inputs, masks.join("\n"));
        const native = JSON.parse(
          run(resolve(project, "build/native", nativePlayer), [
            "--benchmark",
            inputs,
            "--renderer",
            graphics.backend,
            ...(residentMeshes ? ["--gpu-meshes"] : []),
          ]),
        );
        for (const png of name === "still" ? [false, true] : [true]) {
          const web = await page.evaluate(
            async ({ base, language, masks, graphics, png }) => {
              const worker = new Worker(base + "/worker.js", { type: "module" });
              const request = (message, expected) =>
                new Promise((resolve, reject) => {
                  const timer = setTimeout(
                    () => reject(new Error("Imported model worker deadline")),
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
                const ready = await request(
                  { type: "load", gameUrl: location.origin + base + "/" + file, graphics },
                  "ready",
                );
                if (ready.graphics.effective !== graphics.backend) {
                  throw new Error("Incorrect imported model renderer");
                }
                const result = await request({ type: "benchmark", masks }, "benchmark");
                const capture = await request({ type: "capture" }, "capture");
                const pixels = new Uint32Array(capture.pixels);
                result.coloredPixels = [...pixels].filter(
                  (pixel) => pixel !== 0xff322015 && pixel !== 0xffffffff,
                ).length;
                result.width = capture.width;
                return result;
              } finally {
                worker.terminate();
              }
            },
            { base, language, masks, graphics, png },
          );
          const key = `${variant}/${name}/${residentMeshes}/${png}`;
          assert.deepEqual(web.traces, native.traces, `${language}/${key}: native/browser output`);
          assert.equal(web.width, name.startsWith("high") ? 640 : 320);
          assert(web.coloredPixels > 100, "Imported geometry must actually render");
          if (name.includes("turn") || name === "release-recreate") {
            assert(
              new Set(web.traces.map((frame) => frame.hash)).size > 1,
              "Rigid animation/lifecycle must affect pixels",
            );
          }
          if (references.has(key)) {
            assert.deepEqual(web.traces, references.get(key), `${key}: SDK output`);
          } else {
            references.set(key, web.traces);
          }
          if (gpu) {
            for (const stats of [web.gpuStats, native.gpuStats]) {
              assert(stats.materialUploads > 0 && stats.materialUploads <= 64);
              if (name !== "release-recreate") {
                assert(stats.materialCacheHits > stats.materialUploads);
              }
              if (residentMeshes && name !== "release-recreate") {
                assert(stats.cacheHits > stats.meshUploads);
              }
            }
          }
          cases.push({
            language,
            variant,
            name,
            residentMeshes,
            png,
            traces: web.traces,
            gpuStats: web.gpuStats,
          });
        }
      }
    }
    await page.goto(`http://127.0.0.1:${server.address().port}${base}/debug.html?game=./game.png`);
    await page.waitForFunction(() => window.playerStatus?.ready || window.playerStatus?.error);
    assert.equal(await page.evaluate(() => window.playerStatus.error), "");
    await page.screenshot({ path: resolve(root, `${variant}-${language}.png`) });
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
await writeFile(
  resolve(root, "report.json"),
  JSON.stringify({ status: "passed", gpu, cases }, null, 2),
);
console.log(
  `Imported model passed ${cases.length} SDK/host/display/movement/lifecycle/packaging cases (${gpu ? "GPU" : "CPU"}).`,
);
console.log(`Model report: ${relative(process.cwd(), resolve(root, "report.json"))}`);
