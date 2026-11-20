import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { chromium } from "./browser-timing.mjs";
import { createProject, packProject } from "./sdk/project.mjs";

const root = resolve("build/player-loading-verification", randomUUID());
await mkdir(root, { recursive: true });
const sourceRoot = resolve("runtime/odin/web");
const builtRoot = resolve("build/odin-player/web");
const sources = new Map();
for (const name of await readdir(sourceRoot)) {
  if ([".js", ".html"].includes(extname(name))) {
    sources.set(name, await readFile(resolve(sourceRoot, name)));
  }
}
// Package a real SDK starter so metadata and exported profile agree. The raw
// legacy hello fixture intentionally lacks SDK metadata and is not a cartridge.
const project = resolve(root, "fixture");
await createProject(project, "odin");
const packed = await packProject(project);
const cartridge = await readFile(packed.cartridge);
const transfers = new Map();
const requests = new Map();
const timers = new Set();
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  requests.set(pathname, (requests.get(pathname) || 0) + 1);
  if (["/slow.png", "/chunked.png", "/stalled.png"].includes(pathname)) {
    const transfer = { started: Date.now(), writes: 0, received: 0 };
    transfers.set(pathname, transfer);
    const headers = { "Content-Type": "image/png", "Cache-Control": "no-store" };
    if (pathname !== "/chunked.png") {
      headers["Content-Length"] = cartridge.length;
    }
    response.writeHead(200, headers);
    const size = Math.ceil(cartridge.length / 14);
    const send = () => {
      const end = Math.min(cartridge.length, transfer.received + size);
      response.write(cartridge.subarray(transfer.received, end));
      transfer.received = end;
      transfer.writes++;
      if (end === cartridge.length) {
        response.end();
      }
    };
    send();
    if (pathname !== "/stalled.png") {
      const timer = setInterval(send, 1000);
      timers.add(timer);
      response.on("close", () => {
        clearInterval(timer);
        timers.delete(timer);
      });
    }
    return;
  }
  try {
    const name = pathname.slice(1) || "debug.html";
    const file = resolve(builtRoot, name);
    assert(file.startsWith(builtRoot + sep));
    const bytes = sources.get(name) || (await readFile(file));
    const type = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };
    response.writeHead(200, {
      "Content-Type": type[extname(name)] || "application/octet-stream",
      "Content-Length": bytes.length,
      "Cache-Control": "no-store",
    });
    response.end(bytes);
  } catch {
    response.writeHead(404).end("Not found");
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const report = {
  status: "running",
  sourceHashes: Object.fromEntries(
    ["debug-player.js", "session.js", "worker.js", "cartridge.js"].map((name) => [
      name,
      createHash("sha256").update(sources.get(name)).digest("hex"),
    ]),
  ),
  cases: [],
};
let browser;
try {
  browser = await chromium.launch({ channel: process.env.PLAYER_BROWSER_CHANNEL || undefined });
  const results = await Promise.allSettled(
    ["slow", "chunked", "stalled", "local"].map(async (name) => {
      const page = await browser.newPage();
      await page.addInitScript(() => {
        globalThis.loadingMessages = [];
        const OriginalWorker = globalThis.Worker;
        globalThis.Worker = class extends OriginalWorker {
          constructor(...args) {
            super(...args);
            this.addEventListener("message", ({ data }) => {
              if (data.type === "loading") {
                globalThis.loadingMessages.push({ ...data, at: performance.now() });
              }
            });
          }
        };
      });
      try {
        if (name === "local") {
          await page.goto(
            `http://127.0.0.1:${server.address().port}/debug.html?local&game=local-must-not-fetch.png`,
          );
          await page.waitForFunction(() => !!globalThis.playerStatus);
          await page.locator("#graphics-apply").click();
          // Local selection may remain idle beyond the URL startup deadline.
          await page.waitForTimeout(11000);
          assert.equal(requests.get("/local-must-not-fetch.png") || 0, 0);
          assert.equal(await page.evaluate(() => globalThis.playerStatus.error), "");
          await page.locator("#cartridge").setInputFiles({
            name: "loading-regression.png",
            mimeType: "image/png",
            buffer: cartridge,
          });
          await page.waitForFunction(
            () => globalThis.playerStatus.ready || globalThis.playerStatus.error,
          );
          const status = await page.evaluate(() => globalThis.playerStatus);
          report.cases.push({
            name,
            status,
            automaticRequests: requests.get("/local-must-not-fetch.png") || 0,
          });
          assert.equal(status.error, "");
          assert.equal(status.ready, true);
          await page.screenshot({ path: resolve(root, "local.png") });
          return;
        }
        await page.goto(`http://127.0.0.1:${server.address().port}/debug.html?game=${name}.png`);
        await page.waitForFunction(
          () => globalThis.playerStatus?.ready || globalThis.playerStatus?.error,
          null,
          { timeout: 25000 },
        );
        const result = await page.evaluate(() => ({
          status: globalThis.playerStatus,
          progress: globalThis.loadingMessages,
        }));
        const transfer = transfers.get(`/${name}.png`);
        const elapsed = Date.now() - transfer.started;
        report.cases.push({ name, elapsed, ...transfer, ...result });
        await page.screenshot({ path: resolve(root, `${name}.png`) });
        if (name === "stalled") {
          assert.match(result.status.error, /stopped responding/i);
          assert.equal(result.status.ready, false);
          assert(
            elapsed >= 9000 && elapsed < 20000,
            "A stalled body retains a bounded idle deadline",
          );
        } else {
          assert.equal(result.status.error, "", `${name}: active download must not expire`);
          assert.equal(result.status.ready, true);
          assert(elapsed >= 12000, "Real HTTP delivery exceeds the original ten-second deadline");
          assert.equal(transfer.received, cartridge.length);
          const progress = result.progress.filter(
            (message) => message.total === 0 || message.total === cartridge.length,
          );
          assert(progress.length >= 10, "The actual worker reports cartridge byte progress");
          for (let i = 1; i < progress.length; i++) {
            assert(progress[i].received >= progress[i - 1].received);
          }
          assert.equal(progress.at(-1).received, cartridge.length);
        }
      } finally {
        await page.close();
      }
    }),
  );
  report.status = results.every((result) => result.status === "fulfilled") ? "passed" : "failed";
  report.failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => String(result.reason));
  assert.equal(report.status, "passed", report.failures.join("\n"));
} finally {
  await browser?.close();
  for (const timer of timers) {
    clearInterval(timer);
  }
  server.closeAllConnections();
  await new Promise((accept) => server.close(accept));
  await writeFile(resolve(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`Player loading ${report.status}: ${root}`);
}
