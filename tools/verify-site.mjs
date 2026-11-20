import assert from "node:assert/strict";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { once } from "node:events";
import { chromium } from "playwright";
import { serveSite } from "./serve-site.mjs";
import { games } from "../site/catalog.mjs";
import { repo } from "./toolchain.mjs";
import { bindPlayer } from "./browser-player.mjs";

const output = resolve(repo, "build/site");
const artifacts = resolve(repo, "build/site-verification");
await mkdir(artifacts, { recursive: true });
const report = { status: "running", pages: 0, games: [], checks: [] };
async function checkLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "games") {
        await checkLinks(path);
      }
    } else if (entry.name.endsWith(".html")) {
      report.pages++;
      const html = await readFile(path, "utf8");
      for (const [, href] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
        if (/^(https?:|mailto:|data:|#)/.test(href)) {
          continue;
        }
        const target = resolve(dirname(path), decodeURI(href.split(/[?#]/)[0]));
        assert.ok(existsSync(target), `${relative(output, path)} → missing ${href}`);
      }
    }
  }
}
await checkLinks(output);
report.checks.push("All generated local page and asset links resolve");
const searchIndex = JSON.parse(await readFile(resolve(output, "search.json"), "utf8"));
assert.ok(searchIndex.some(({ url }) => url === "docs/sdk/README.html"));
assert.ok(searchIndex.some(({ url }) => url === "docs/sdk/audio.html"));
for (const { url } of searchIndex) {
  assert.doesNotMatch(
    url,
    /internal\/|measurements|research|experiments\/|adr\/|implementation-plan/,
  );
}
for (const path of [
  "docs/docs/audio-measurements.html",
  "docs/docs/implementation-plan.html",
  "docs/docs/internal/measurements/audio-measurements.html",
  "source/docs/internal/measurements/audio-measurements.md.html",
  "docs/examples/kart3d/docs/kart-quality-measurements.html",
]) {
  assert.ok(!existsSync(resolve(output, path)), `Internal page still published: ${path}`);
}
report.checks.push("SDK guides are searchable; internal reports and stale pages are unpublished");
const server = serveSite({ port: 0 });
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PLAYER_BROWSER_CHANNEL || undefined });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.screenshot({ path: resolve(artifacts, "landing-desktop.png"), fullPage: true });
  await page.getByRole("link", { name: "Documentation", exact: true }).click();
  await page.getByRole("searchbox").fill("synthesis");
  await page.waitForFunction(() => document.querySelector("#search-results li"));
  assert.match(await page.locator("#search-results").innerText(), /synthesis/i);
  await page.getByRole("searchbox").fill("no_such_document_8675309");
  await page.waitForFunction(() =>
    document.querySelector("#search-status").textContent.startsWith("No documents"),
  );
  await page.getByRole("searchbox").fill("");
  assert.equal(await page.locator("#search-results li").count(), 0);
  await page.screenshot({ path: resolve(artifacts, "docs-desktop.png"), fullPage: true });
  report.checks.push("Full-text search, no-results state, clearing search");
  await page.goto(`${base}/showcase/`);
  for (const [label, expected] of [
    ["Racing", "Copper Circuit"],
    ["Adventure", "Mossglen"],
  ]) {
    const filter = page.getByRole("button", { name: label, exact: true });
    await filter.click();
    assert.equal(await filter.getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".game-card:visible").count(), 1);
    assert.match(await page.locator(".game-card:visible").innerText(), new RegExp(expected));
  }
  await page.getByRole("button", { name: "All games", exact: true }).click();
  assert.equal(await page.locator(".game-card:visible").count(), games.length);
  report.checks.push("Game category filters select and restore playable cartridges");
  await page.screenshot({ path: resolve(artifacts, "showcase-desktop.png"), fullPage: true });
  await page.close();

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  const mobile = await context.newPage();
  mobile.on("pageerror", (error) => errors.push(error.message));
  for (const url of ["/", "/docs/", "/docs/sdk/api.html", "/showcase/"]) {
    await mobile.goto(`${base}${url}`);
    assert.ok(
      await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      `Mobile overflow: ${url}`,
    );
  }
  await mobile.goto(base);
  await mobile.screenshot({ path: resolve(artifacts, "landing-mobile.png"), fullPage: true });
  report.checks.push("390px mobile layout: home, docs, API reference, showcase");
  for (const game of games) {
    await mobile.goto(`${base}/showcase/${game.id}/`);
    assert.equal(await mobile.locator("iframe").count(), 0, "Player must be lazy loaded");
    await mobile.locator("#launch").click();
    for (const language of ["luau", "odin"]) {
      if (language === "odin") {
        await mobile.locator("#language").selectOption(language);
      }
      const frame = await (await mobile.locator("iframe").elementHandle()).contentFrame();
      await bindPlayer(frame);
      await frame.waitForFunction(() => window.hostedPlayer.runtime.getSnapshot().ready, null, {
        timeout: 60000,
      });
      assert.equal(
        await frame.evaluate(async () => window.hostedPlayer.runtime.getSnapshot().error),
        "",
      );
      await frame.getByRole("button", { name: "Play game", exact: true }).click();
      await frame.waitForFunction(() => window.hostedPlayer.runtime.getSnapshot().ticks > 5);
      if (game.id === "copper-circuit") {
        await frame.waitForFunction(() => window.hostedPlayer.runtime.getSnapshot().ticks > 190);
      }
      const initial = await frame.evaluate(async () => ({
        spawnPixels: Array.from(
          window.hostedPlayer.element.shadowRoot
            .querySelector("canvas")
            .getContext("2d")
            .getImageData(80, 88, 16, 16).data,
        ),
        hash: window.hostedPlayer.runtime.getSnapshot().hash,
        ticks: window.hostedPlayer.runtime.getSnapshot().ticks,
      }));
      const direction = frame.locator(
        `[data-control="${game.id === "mossglen" ? "right" : "up"}"]`,
      );
      const action = frame.locator('[data-control="action"]');
      await direction.scrollIntoViewIfNeeded();
      const d = await direction.boundingBox();
      const a = await action.boundingBox();
      const session = await context.newCDPSession(mobile);
      const pressTick = await frame.evaluate(
        async () => window.hostedPlayer.runtime.getSnapshot().ticks,
      );
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: d.x + d.width / 2, y: d.y + d.height / 2, id: 1 }],
      });
      await frame.waitForFunction(
        () =>
          window.hostedPlayer.element.shadowRoot.querySelectorAll(".touch-key.pressed").length ===
          1,
      );
      await frame.waitForFunction(
        (tick) => window.hostedPlayer.runtime.getSnapshot().ticks > tick + 25,
        pressTick,
      );
      const after = await frame.evaluate(async () => ({
        spawnPixels: Array.from(
          window.hostedPlayer.element.shadowRoot
            .querySelector("canvas")
            .getContext("2d")
            .getImageData(80, 88, 16, 16).data,
        ),
        hash: window.hostedPlayer.runtime.getSnapshot().hash,
      }));
      assert.notEqual(after.hash, initial.hash, "Touch input changes rendered gameplay");
      if (game.id === "mossglen") {
        // The RPG starts at tile (5, 6), drawn at (80, 88). The public player
        // diagnostics do not expose cartridge-owned RPG coordinates.
        assert.notDeepEqual(
          after.spawnPixels,
          initial.spawnPixels,
          "Touch direction moves the RPG sprite away from its spawn tile",
        );
      }
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [
          { x: d.x + d.width / 2, y: d.y + d.height / 2, id: 1 },
          { x: a.x + a.width / 2, y: a.y + a.height / 2, id: 2 },
        ],
      });
      await frame.waitForFunction(
        () =>
          window.hostedPlayer.element.shadowRoot.querySelectorAll(".touch-key.pressed").length ===
          2,
      );
      await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
      assert.equal(
        await frame.locator(".touch-key.pressed").count(),
        0,
        "Canceled touches release all controls",
      );
      await session.detach();
      assert.match(
        await mobile.locator("#download").getAttribute("href"),
        new RegExp(`${language}\\.png$`),
      );
      const png = await (
        await fetch(new URL(await mobile.locator("#download").getAttribute("href"), mobile.url()))
      ).arrayBuffer();
      assert.equal(Buffer.from(png).subarray(1, 4).toString(), "PNG");
      report.games.push({
        game: game.id,
        language,
        ticks: initial.ticks,
        touch: "multitouch movement and cancellation passed",
      });
    }
    await mobile.screenshot({ path: resolve(artifacts, `${game.id}-mobile.png`), fullPage: true });
    await mobile.locator("#restart").click();
    const restarted = await (await mobile.locator("iframe").elementHandle()).contentFrame();
    await bindPlayer(restarted);
    await restarted.waitForFunction(() => window.hostedPlayer.runtime.getSnapshot().ready, null, {
      timeout: 60000,
    });
  }
  assert.deepEqual(errors, [], "No page script errors");
  report.status = "passed";
  console.log(
    `Site passed: ${report.pages} pages, search, mobile layout, four playable cartridges, multitouch and cancellation.`,
  );
} catch (error) {
  report.status = "failed";
  report.error = error.stack;
  throw error;
} finally {
  await writeFile(resolve(artifacts, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  await new Promise((done) => server.close(done));
}
