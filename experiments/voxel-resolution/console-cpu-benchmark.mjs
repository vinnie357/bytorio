import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { serve } from "../../tools/serve.mjs";

const root = resolve("build/compact-3d/riverside");
const geometry = JSON.parse(await readFile(resolve(root, "geometry.json")));
const server = serve(".", 0);
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PLAYER_BROWSER_CHANNEL || "chrome" });
const report = {
  status: "running",
  recordedAt: new Date().toISOString(),
  scope:
    "Interactive browser CPU rendering, presentation, frame transfer and canvas delivery. Static scene; SSAA and output sizes are recorded independently. Not comparable to pure GPU timing.",
  cases: [],
  binaries: {},
};
const configurations = [
  { name: "direct", width: 320, ssaa: "off" },
  { name: "snap", width: 320, ssaa: "off", pixelSnap: true },
  { name: "smooth", width: 320, ssaa: "off", smoothPan: true },
  { name: "smooth", width: 320, ssaa: "off", smoothPan: true, motion: "orbit" },
  { name: "smooth", width: 320, ssaa: "off", smoothPan: true, motion: "walk" },
  { name: "smooth", width: 640, ssaa: "off", smoothPan: true },
  { name: "smooth", width: 320, ssaa: "2x", smoothPan: true },
  { name: "smooth", width: 320, ssaa: "1080p", smoothPan: true },
];
try {
  for (const language of ["odin", "luau"]) {
    report.binaries[language] = {};
    for (const file of ["runtime.wasm", "worker.js", "debug-player.js", "session.js", "game.png"]) {
      const bytes = await readFile(resolve(root, language, "build/web", file));
      report.binaries[language][file] = createHash("sha256").update(bytes).digest("hex");
    }
    for (const config of configurations) {
      // Leave enough room for player chrome and a full 1920x1080 presentation.
      const page = await browser.newPage({ viewport: { width: 1952, height: 1230 } });
      await page.addInitScript(() => {
        const OriginalWorker = window.Worker;
        window.cpuFrameSamples = [];
        window.Worker = class extends OriginalWorker {
          constructor(...args) {
            super(...args);
            this.addEventListener("message", ({ data }) => {
              if (data.type === "frame") {
                window.cpuFrameSamples.push({
                  time: performance.now(),
                  renderMs: data.metrics.renderMs,
                });
              }
            });
          }
        };
      });
      const query = new URLSearchParams({ renderer: "cpu", ssaa: config.ssaa });
      if (config.pixelSnap) {
        query.set("pixel-snap", "");
      }
      if (config.smoothPan) {
        query.set("smooth-pan", "");
      }
      await page.goto(
        `${origin}/build/compact-3d/riverside/${language}/build/web/debug.html?${query}`,
      );
      await page.waitForFunction(() => window.playerStatus?.ready || window.playerStatus?.error);
      await page.locator("#start").click();
      if (config.width === 640) {
        await page.locator("#canvas").focus();
        await page.keyboard.down("Space");
      }
      await page.waitForFunction(
        (ticks) => window.playerStatus?.ticks >= ticks || window.playerStatus?.error,
        geometry.loadingUpdates + 12,
        { timeout: 60000 },
      );
      const start = await page.evaluate(() => {
        window.cpuFrameSamples = [];
        return performance.now();
      });
      if (config.motion) {
        await page.locator("#canvas").focus();
        await page.keyboard.down(config.motion === "orbit" ? "q" : "d");
      }
      await page.waitForTimeout(2000);
      const captured = await page.evaluate(() => ({
        end: performance.now(),
        samples: window.cpuFrameSamples,
        status: window.playerStatus,
      }));
      assert.equal(captured.status.error, "");
      assert.equal(captured.status.width, config.width);
      assert.equal(captured.status.metrics.gpuCacheBytes, 0);
      assert(captured.samples.length > 0);
      if (config.smoothPan) {
        assert.equal(captured.status.presentationWidth, 1920);
      }
      const sorted = captured.samples.map((sample) => sample.renderMs).sort((a, b) => a - b);
      const result = {
        language,
        ...config,
        presentation: [captured.status.presentationWidth, captured.status.presentationHeight],
        deliveredFps: (captured.samples.length * 1000) / (captured.end - start),
        renderP50Ms: sorted[Math.floor(sorted.length / 2)],
        renderP95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
        memory: captured.status.metrics.memory,
        cpuQualityBytes: captured.status.metrics.cpuQualityBytes,
      };
      report.cases.push(result);
      console.log(
        `${language} ${config.width} ${config.name} ${config.motion || "static"} SSAA ${config.ssaa}: ${result.deliveredFps.toFixed(1)} FPS; render p95 ${result.renderP95Ms.toFixed(2)} ms`,
      );
      await page.close();
    }
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  throw error;
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
  await writeFile(resolve(root, "cpu-performance.json"), JSON.stringify(report, null, 2) + "\n");
}
