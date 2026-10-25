import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";
import { chromium } from "./browser-timing.mjs";
import { buildTexturedDrawing } from "./build-textured-3d.mjs";
import { run, tool, copySdlLibrary, nativeLinkerFlags, nativePlayer } from "./toolchain.mjs";
import { serve } from "./serve.mjs";

const root = resolve("build/textured-gpu-validation", randomUUID());
const { buttons } = JSON.parse(await readFile("sdk/contract.json"));
await mkdir(root, { recursive: true });
const projects = await buildTexturedDrawing(resolve(root, "players"));
run(tool("odin"), [
  "build",
  "tests/gpu/native",
  "-o:none",
  `-out:${root}/device.exe`,
  ...nativeLinkerFlags({ harness: true }),
]);
await copySdlLibrary(root);
assert.equal(JSON.parse(run(resolve(root, "device.exe"), [])).pixel, 0xff0000ff);
const server = serve(".", 0);
await once(server, "listening");
const browser = await chromium.launch({ channel: process.env.PLAYER_BROWSER_CHANNEL || "chrome" });
const results = [];
try {
  const page = await browser.newPage();
  for (const { language, project } of projects) {
    const base = "/" + relative(process.cwd(), resolve(project, "build/web")).replaceAll("\\", "/");
    await page.goto(`http://127.0.0.1:${server.address().port}${base}/player.html`);
    for (const residentMeshes of [false, true]) {
      for (const ssaa of ["off", "2x", "1080p"]) {
        for (const [name, mask] of [
          ["stationary", 0],
          ["moving", buttons.right],
          ["high", buttons.action],
          ["edited", buttons.up],
        ]) {
          const masks = Array(6).fill(mask);
          const inputs = resolve(root, `${language}-${name}.inputs`);
          await writeFile(inputs, masks.join("\n") + "\n");
          const native = JSON.parse(
            run(resolve(project, "build/native", nativePlayer), [
              "--benchmark",
              inputs,
              "--renderer",
              "gpu",
              "--ssaa",
              ssaa,
              ...(residentMeshes ? ["--gpu-meshes"] : []),
            ]),
          );
          const web = await page.evaluate(
            async ({ base, ssaa, residentMeshes, masks }) => {
              const worker = new Worker(base + "/worker.js", { type: "module" });
              const request = (message, expected) =>
                new Promise((resolve, reject) => {
                  const timer = setTimeout(
                    () => reject(new Error("Textured GPU deadline")),
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
                const loaded = await request(
                  {
                    type: "load",
                    gameUrl: location.origin + base + "/game.png",
                    graphics: { backend: "gpu", ssaa, residentMeshes },
                  },
                  "ready",
                );
                if (loaded.graphics.effective !== "gpu") {
                  throw new Error("GPU execution was not selected");
                }
                const result = await request({ type: "benchmark", masks }, "benchmark");
                const capture = await request({ type: "capture" }, "capture");
                const pixels = new DataView(capture.pixels);
                result.center = pixels.getUint32(
                  (Math.floor(capture.height / 2) * capture.width + Math.floor(capture.width / 2)) *
                    4,
                  true,
                );
                result.width = capture.width;
                return result;
              } finally {
                worker.terminate();
              }
            },
            { base, ssaa, residentMeshes, masks },
          );
          assert.deepEqual(
            web.traces,
            native.traces,
            `${language}/${ssaa}/${residentMeshes}/${name}: GPU parity`,
          );
          assert.equal(web.center, name === "edited" ? 0xff000080 : 0xff00ff00);
          assert.equal(web.width, name === "high" ? 640 : 320);
          for (const [host, stats] of [
            ["browser", web.gpuStats],
            ["native", native.gpuStats],
          ]) {
            assert(
              stats.materialUploads > 0 && stats.materialUploads <= (name === "edited" ? 16 : 8),
              `${host}: bounded texture uploads`,
            );
            assert(
              stats.materialCacheHits > stats.materialUploads,
              `${host}: texture snapshot reuse`,
            );
            assert.equal(stats.materialUploadBytes, stats.materialUploads * 16);
            assert(stats.materialCacheBytes <= 32 * 1024 * 1024);
            if (residentMeshes) {
              assert(
                stats.meshUploads > 0 && stats.meshUploads <= 8,
                `${host}: geometry remains resident`,
              );
              assert.equal(stats.uploadBytes, stats.meshUploads * 168);
            }
          }
          results.push({
            language,
            ssaa,
            residentMeshes,
            name,
            hash: web.traces[0].hash,
            native: native.gpuStats,
            browser: web.gpuStats,
          });
        }
      }
    }
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
await writeFile(
  resolve(root, "report.json"),
  JSON.stringify({ status: "passed", cases: results }, null, 2),
);
console.log(
  `Textured GPU passed ${results.length} SDK/quality/residency/display/motion/edit cases on native and browser.`,
);
