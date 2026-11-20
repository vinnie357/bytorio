import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { chromium } from "../../../tools/browser-timing.mjs";
import { serve } from "../../../tools/serve.mjs";
import { run, nativePlayer } from "../../../tools/toolchain.mjs";

// A small rigid, rotating textured model isolates material batch overhead. It
// is a renderer proxy, not the future playable racing showcase or a frame cap.
const baselineIndex = process.argv.indexOf("--baseline");
if (baselineIndex !== -1 && !process.argv[baselineIndex + 1]) {
  throw new Error("--baseline requires a previously exported model directory");
}
const versions = baselineIndex === -1 ? [] : [["before", process.argv[baselineIndex + 1]]];
versions.push(["after", "examples/models/build"]);
const root = resolve("examples/models/build/benchmarks", randomUUID());
await mkdir(root, { recursive: true });
const masks = Array(32).fill(2);
const inputs = resolve(root, "turn.inputs");
await writeFile(inputs, masks.join("\n") + "\n");
const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const server = serve(".", 0);
await once(server, "listening");
const browser = await chromium.launch({ channel: process.env.PLAYER_BROWSER_CHANNEL || "chrome" });
const rows = [];
try {
  const page = await browser.newPage();
  for (const language of ["odin", "luau"]) {
    // Feed one freshly built cartridge to both runtimes; compiler rebuilds
    // need not reproduce the bytes saved with an older player export.
    const game = resolve("examples/models/build", language, "build/web/game.png");
    const gameUrl = "/" + relative(process.cwd(), game).replaceAll("\\", "/");
    for (const ssaa of ["off", "1080p"]) {
      for (const [version, directory] of versions) {
        const base = resolve(directory, language, "build");
        const web = "/" + relative(process.cwd(), resolve(base, "web")).replaceAll("\\", "/");
        const url = `http://127.0.0.1:${server.address().port}${web}/player.html`;
        await page.goto(url);
        const native = JSON.parse(
          run(resolve(base, `native/${nativePlayer}`), [
            "--benchmark",
            inputs,
            "--game",
            game,
            "--renderer",
            "gpu",
            "--gpu-meshes",
            "--ssaa",
            ssaa,
          ]),
        );
        const browserResult = await page.evaluate(
          async ({ web, gameUrl, masks, ssaa }) => {
            const worker = new globalThis.Worker(web + "/worker.js", { type: "module" });
            const request = (message, expected) =>
              new Promise((resolve, reject) => {
                const timer = setTimeout(
                  () => reject(new Error("Attachment benchmark deadline")),
                  120000,
                );
                const fail = (error) => {
                  clearTimeout(timer);
                  reject(error);
                };
                worker.onerror = (event) => fail(new Error(event.message));
                worker.onmessage = async ({ data }) => {
                  try {
                    if (data.type === "executor") {
                      const bytes = await (await fetch(web + "/luau-executor.wasm")).arrayBuffer();
                      worker.postMessage({ type: "executor", executor: { bytes } }, [bytes]);
                    } else if (data.type === "error") {
                      fail(new Error(data.error));
                    } else if (data.type === expected) {
                      clearTimeout(timer);
                      data.bitmap?.close();
                      resolve(data);
                    }
                  } catch (error) {
                    fail(error);
                  }
                };
                worker.postMessage(message);
              });
            try {
              const ready = await request(
                {
                  type: "load",
                  gameUrl: globalThis.location.origin + gameUrl,
                  graphics: { backend: "gpu", residentMeshes: true, ssaa },
                },
                "ready",
              );
              if (ready.graphics.effective !== "gpu") {
                throw new Error("GPU unavailable");
              }
              return await request({ type: "benchmark", masks }, "benchmark");
            } finally {
              worker.terminate();
            }
          },
          { web, gameUrl, masks, ssaa },
        );
        assert.deepEqual(native.traces, browserResult.traces, "Native/browser proxy output");
        rows.push({
          version,
          language,
          ssaa,
          cartridge: await digest(game),
          nativePlayer: await digest(resolve(base, `native/${nativePlayer}`)),
          browserRuntime: await digest(resolve(base, "web/runtime-gpu.wasm")),
          browserDevice: await digest(resolve(base, "web/gpu.js")),
          native,
          browser: browserResult,
        });
        console.log(`${version}/${language}/${ssaa}: complete`);
      }
    }
  }
  for (const after of rows.filter((row) => row.version === "after")) {
    const before = rows.find(
      (row) =>
        row.version === "before" && row.language === after.language && row.ssaa === after.ssaa,
    );
    if (before) {
      assert.equal(after.cartridge, before.cartridge, "Comparison uses identical cartridge bytes");
      if (after.ssaa === "off") {
        assert.deepEqual(
          after.native.traces,
          before.native.traces,
          "Direct rendering output unchanged",
        );
      }
    }
    for (const stats of [after.native.gpuStats, after.browser.gpuStats]) {
      assert(
        stats.attachmentBatches > stats.attachmentSequences,
        "Compatible batches must reuse attachments",
      );
      assert(stats.publishedFrames > 0);
      assert(stats.directPresents > 0);
      assert(stats.snapshotReadbackBytes > 0, "Explicit diagnostic hashes restore CPU visibility");
      assert(stats.attachmentReadbackBytes < stats.attachmentUploadBytes);
      assert(stats.frameBytes > 0);
      assert(stats.attachmentBytes > 0);
      assert(stats.cacheHits > stats.meshUploads);
    }
  }
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
const report = resolve(root, "report.json");
await writeFile(
  report,
  JSON.stringify(
    {
      status: "passed",
      recordedAt: new Date().toISOString(),
      workload: "rotating imported rigid model",
      rows,
    },
    null,
    2,
  ),
);
console.log(`Attachment benchmark: ${relative(process.cwd(), report)}`);
