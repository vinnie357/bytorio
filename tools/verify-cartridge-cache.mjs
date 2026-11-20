import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { chromium } from "./browser-timing.mjs";
import { createProject, packProject } from "./sdk/project.mjs";

const root = resolve("build/cartridge-cache-verification", randomUUID());
const project = resolve(root, "fixture");
await mkdir(root, { recursive: true });
await createProject(project, "odin");
const revisions = [];
for (const title of ["Cache revision A", "Cache revision B"]) {
  const config = JSON.parse(await readFile(resolve(project, "console.json")));
  config.title = title;
  await writeFile(resolve(project, "console.json"), JSON.stringify(config, null, 2));
  const packed = await packProject(project);
  const png = await readFile(packed.cartridge);
  const html = await readFile(resolve(project, "build/web/debug.html"), "utf8");
  const revision = createHash("sha256").update(png).digest("hex");
  assert(
    html.includes(`./game.png?revision=${revision}`),
    "Export pins the exact runnable PNG revision",
  );
  revisions.push({ title, png, html, revision });
}
assert.notEqual(revisions[0].revision, revisions[1].revision);
let selected = revisions[0];
const requests = [];
const timers = new Set();
const base = resolve(project, "build/web");
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  try {
    let bytes;
    if (url.pathname.endsWith(".png")) {
      requests.push({ path: url.pathname, revision: url.searchParams.get("revision") });
      bytes =
        revisions.find((item) => item.revision === url.searchParams.get("revision"))?.png ||
        selected.png;
    } else if (url.pathname === "/debug.html") {
      bytes = Buffer.from(selected.html);
    } else {
      const path = resolve(base, `.${url.pathname}`);
      assert(path.startsWith(base + sep));
      bytes = await readFile(path);
    }
    const types = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".wasm": "application/wasm",
      ".png": "image/png",
    };
    response.writeHead(200, {
      "Content-Type": types[extname(url.pathname)] || "application/octet-stream",
      "Content-Length": bytes.length,
      "Cache-Control": "no-store",
    });
    if (url.pathname === "/game.png" && requests.length === 1) {
      // A cache miss must report progress while CacheStorage consumes a slow
      // body; the actual player still has its ten-second idle watchdog.
      let offset = 0;
      const step = Math.ceil(bytes.length / 14);
      const send = () => {
        const end = Math.min(bytes.length, offset + step);
        response.write(bytes.subarray(offset, end));
        offset = end;
        if (offset === bytes.length) {
          response.end();
        }
      };
      send();
      const timer = setInterval(send, 1000);
      timers.add(timer);
      response.on("close", () => {
        clearInterval(timer);
        timers.delete(timer);
      });
    } else {
      response.end(bytes);
    }
  } catch {
    response.writeHead(404).end("Not found");
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const report = { status: "running", revisions: revisions.map((item) => item.revision), requests };
let browser;
try {
  browser = await chromium.launch({ channel: process.env.PLAYER_BROWSER_CHANNEL || undefined });
  const page = await browser.newPage();
  const url = `http://127.0.0.1:${server.address().port}/debug.html`;
  const ready = async (title) => {
    await page.waitForFunction(
      () => globalThis.playerStatus?.ready || globalThis.playerStatus?.error,
    );
    assert.equal(await page.evaluate(() => globalThis.playerStatus.error), "");
    assert.equal(await page.title(), title);
  };
  await page.goto(url);
  await ready(revisions[0].title);
  assert.equal(requests.length, 1);
  await page.reload();
  await ready(revisions[0].title);
  assert.equal(requests.length, 1, "Refresh makes zero additional cartridge HTTP requests");
  selected = revisions[1];
  await page.reload();
  await ready(revisions[1].title);
  assert.equal(requests.length, 2, "Changed revision fetches the new cartridge");
  assert.equal(requests[1].revision, revisions[1].revision);
  await page.reload();
  await ready(revisions[1].title);
  assert.equal(requests.length, 2);
  await page.screenshot({ path: resolve(root, "cached-refresh.png") });
  await page.goto(`${url}?local`);
  await page.waitForFunction(() => !!globalThis.playerStatus);
  await page
    .locator("#cartridge")
    .setInputFiles({ name: "local.png", mimeType: "image/png", buffer: revisions[0].png });
  await ready(revisions[0].title);
  assert.equal(requests.length, 2, "Local File bypasses network and cartridge cache");
  report.cacheEntries = await page.evaluate(async () =>
    (await (await caches.open("bytorio-cartridges-v1")).keys()).map((request) => request.url),
  );
  assert.equal(report.cacheEntries.length, 2);
  report.fallbacks = [];
  for (const failure of ["unavailable", "quota"]) {
    const before = requests.length;
    const result = await page.evaluate(
      async ({ failure, revision }) => {
        const { fetchCartridge } = await import("./cartridge-cache.js");
        const storage = {
          async open() {
            if (failure === "unavailable") {
              throw new DOMException("Storage denied", "SecurityError");
            }
            return {
              async match() {
                return undefined;
              },
              async put() {
                throw new DOMException("Storage full", "QuotaExceededError");
              },
            };
          },
        };
        const response = await fetchCartridge(
          new URL(`./fallback.png?revision=${revision}`, location.href),
          { cacheStorage: storage },
        );
        const bytes = await response.arrayBuffer();
        const hash = await crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(
          "",
        );
      },
      { failure, revision: selected.revision },
    );
    assert.equal(result, selected.revision);
    const addedRequests = requests.length - before;
    assert.equal(addedRequests, failure === "quota" ? 2 : 1);
    report.fallbacks.push({ failure, addedRequests, exactResponse: true });
  }
  report.status = "passed";
} finally {
  await browser?.close();
  for (const timer of timers) {
    clearInterval(timer);
  }
  server.closeAllConnections();
  await new Promise((accept) => server.close(accept));
  await writeFile(resolve(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`Cartridge cache ${report.status}: ${root}`);
}
