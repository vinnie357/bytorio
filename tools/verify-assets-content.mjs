import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { timedSpawnSync as spawnSync } from "./command-timing.mjs";
import { createProject, buildProject } from "./sdk/project.mjs";
import { bundleLuau } from "./sdk/bundle.mjs";
import { graphicsPacket } from "./sdk/assets.mjs";
import { encodeCartridge } from "./sdk/cartridge.mjs";
import { nativePlayer } from "./toolchain.mjs";
import { chromium } from "./browser-timing.mjs";
import { serve } from "./serve.mjs";
import { contentImports, decodeCartridge } from "../runtime/odin/web/cartridge.js";
import { MAX_GRAPHICS_BYTES } from "../runtime/odin/web/constants.js";
import {
  loadSource,
  checkExecutor,
  uploadGraphics,
  submitDrawing,
  rasterizeDrawing,
} from "../runtime/odin/web/policy.js";

const root = resolve("build/assets-content-verification", randomUUID());
const project = resolve(root, "luau");
const id = 731;
const missingId = 987654;
const assets = {
  palette: Array(16).fill("#000000"),
  sprites: [Array(16).fill("2222222222222222")],
  font: { A: Array(7).fill("11111") },
};
assets.palette[2] = "#123456";
const { packet } = graphicsPacket(assets);
const fallback = graphicsPacket({
  ...assets,
  sprites: [Array(16).fill("1111111111111111")],
}).packet;
const literal =
  '"' + [...packet].map((value) => "\\" + String(value).padStart(3, "0")).join("") + '"';
const statements = {
  base64: `byt.assets("${packet.toString("base64")}")`,
  content: `byt.assets(${id})`,
  buffer: `local bytes=buffer.fromstring(${literal})\nbyt.assets(bytes)\nbuffer.fill(bytes,0,0)`,
  missing: `byt.assets(${missingId})`,
  oversized: `byt.assets(buffer.create(${MAX_GRAPHICS_BYTES + 1}))`,
};
const fixtures = new Map();
let executorBytes;
let runtimeBytes;
let browser;
let server;
let serverReady;

before(async () => {
  await mkdir(root, { recursive: true });
  await createProject(project, "luau");
  await buildProject(project);
  executorBytes = await readFile(resolve(project, "build/web/luau-executor.wasm"));
  runtimeBytes = await readFile(resolve(project, "build/web/runtime.wasm"));
  await writeFile(
    resolve(project, "build/web/assets-content.html"),
    "<!doctype html><meta charset=utf-8><title>Graphics content conformance</title>",
  );
  for (const [name, statement] of Object.entries(statements)) {
    for (const phase of ["load", "init", "update", "draw"]) {
      const entry = resolve(project, "src/main.luau");
      await writeFile(
        entry,
        `local byt=require("@bytorio")\n${phase === "load" ? statement : ""}\nreturn {
          init=function() ${phase === "init" ? statement : ""} end,
          update=function() ${phase === "update" ? statement : ""} end,
          draw=function()
            ${phase === "draw" ? statement : ""}
            byt.clear(byt.rgb(1,2,3))
            byt.sprite(0,16,16)
            byt.text("A",40,16,byt.rgb(250,240,230))
          end,
        }\n`,
      );
      const source = await bundleLuau({
        entry,
        project,
        sdkRoot: resolve("sdk/luau"),
        assets: fallback,
      });
      const png = encodeCartridge({
        title: "Graphics content conformance",
        profile: "2d-preview-1",
        language: "luau",
        display: [640, 360],
        code: source,
        assets,
        content: [{ id, bytes: packet }],
      });
      const file = `${name}-${phase}.png`;
      await writeFile(resolve(project, "build/web", file), png);
      fixtures.set(`${name}-${phase}`, { png, source, file });
    }
  }
});

after(async () => {
  await browser?.close();
  if (server) {
    await new Promise((done) => server.close(done));
  }
});

async function runtimeFrame(fixture, readFails = false, update = false) {
  const runtime = (await WebAssembly.instantiate(runtimeBytes, { env: { sin: Math.sin } })).instance
    .exports;
  decodeCartridge(runtime, fixture.png);
  const imports = contentImports(runtime, () => game);
  const game = (
    await WebAssembly.instantiate(executorBytes, {
      env: {
        ...imports,
        ...(readFails ? { content_read: () => 0 } : {}),
        save_size: () => 0,
        save_status: () => 3,
        save_read: () => 0,
        save_write: () => 3,
        text_configure: () => 0,
        text_read: () => 0,
      },
    })
  ).instance.exports;
  game._initialize?.();
  loadSource(game, fixture.source);
  runtime.runtime_init();
  game.game_init();
  checkExecutor(game);
  uploadGraphics(game, runtime);
  if (update) {
    game.game_update(0, 0, 0, 0);
    checkExecutor(game);
  }
  const drawing = submitDrawing(game, runtime);
  rasterizeDrawing(runtime, drawing);
  return {
    hash: runtime.runtime_hash() >>> 0,
    pixels: Buffer.from(
      new Uint8Array(
        runtime.memory.buffer,
        runtime.runtime_pixels(),
        drawing.width * drawing.height * 4,
      ),
    ),
  };
}

function nativeResult(fixture) {
  const result = spawnSync(
    resolve(project, "build/native", nativePlayer),
    [resolve(project, "build/web", fixture.file), "--smoke"],
    {
      encoding: "utf8",
      timeout: 30000,
      env: {
        ...process.env,
        SDL_VIDEODRIVER: "dummy",
        SDL_AUDIODRIVER: "dummy",
        SDL_RENDER_DRIVER: "software",
      },
    },
  );
  assert.ifError(result.error);
  return result;
}

function nativeFrame(fixture) {
  const result = nativeResult(fixture);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout);
}

async function browserFrame(fixture) {
  serverReady ||= (async () => {
    server = serve(root, 0);
    await once(server, "listening");
  })();
  await serverReady;
  browser ||= await chromium.launch({
    channel: process.env.PLAYER_BROWSER_CHANNEL || "chrome",
    headless: true,
  });
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/luau/build/web/assets-content.html`);
    return await page.evaluate(async (file) => {
      const worker = new Worker("./worker.js", { type: "module" });
      try {
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Graphics content worker deadline")),
            30000,
          );
          worker.onerror = (event) => {
            clearTimeout(timer);
            reject(new Error(event.message));
          };
          worker.onmessage = async ({ data }) => {
            if (data.type === "executor") {
              try {
                const bytes = await (await fetch("./luau-executor.wasm")).arrayBuffer();
                worker.postMessage({ type: "executor", executor: { bytes } });
              } catch (error) {
                clearTimeout(timer);
                reject(error);
              }
            }
            if (data.type === "error") {
              clearTimeout(timer);
              reject(new Error(data.error));
            }
            if (data.type === "ready") {
              clearTimeout(timer);
              resolve({ hash: data.hash, pixels: Array.from(new Uint8Array(data.pixels)) });
            }
          };
          worker.postMessage({ type: "load", gameUrl: new URL(file, location.href).href });
        });
      } finally {
        worker.terminate();
      }
    }, fixture.file);
  } finally {
    await page.close();
  }
}

for (const phase of ["load", "init"]) {
  test(`base64 graphics ${phase} has independent sprite, palette and font pixels`, async () => {
    const frame = await runtimeFrame(fixtures.get(`base64-${phase}`));
    assert.deepEqual([...frame.pixels.subarray(0, 4)], [1, 2, 3, 255]);
    const sprite = (16 * 640 + 16) * 4;
    assert.deepEqual([...frame.pixels.subarray(sprite, sprite + 4)], [18, 52, 86, 255]);
    const glyph = (16 * 640 + 40) * 4;
    assert.deepEqual([...frame.pixels.subarray(glyph, glyph + 4)], [250, 240, 230, 255]);
  });
  for (const host of ["native", "browser"]) {
    test(`${host} base64 graphics during ${phase} equals the independent reference`, async () => {
      const fixture = fixtures.get(`base64-${phase}`);
      const expected = await runtimeFrame(fixture);
      if (host === "native") {
        assert.equal(nativeFrame(fixture).hash, expected.hash);
      } else {
        const actual = await browserFrame(fixture);
        assert.equal(actual.hash, expected.hash);
        assert.deepEqual(Buffer.from(actual.pixels), expected.pixels);
      }
    });
  }
  for (const host of ["runtime", "native", "browser"]) {
    for (const source of ["content", "buffer"]) {
      test(`${host} ${source} graphics during ${phase} equals base64 frame`, async () => {
        const reference = fixtures.get(`base64-${phase}`);
        const fixture = fixtures.get(`${source}-${phase}`);
        if (host === "native") {
          const expected = await runtimeFrame(reference);
          assert.equal(nativeFrame(reference).hash, expected.hash);
          assert.equal(nativeFrame(fixture).hash, expected.hash);
        } else if (host === "browser") {
          const expected = await runtimeFrame(reference);
          const actual = await browserFrame(fixture);
          assert.equal(actual.hash, expected.hash);
          assert.deepEqual(Buffer.from(actual.pixels), expected.pixels);
        } else {
          assert.deepEqual(await runtimeFrame(fixture), await runtimeFrame(reference));
        }
      });
    }
    for (const [source, error] of [
      ["missing", new RegExp(`content.*${missingId}|${missingId}.*content`, "i")],
      ["oversized", /graphics.*(large|limit|size|bytes)|MAX_GRAPHICS_BYTES/i],
    ]) {
      test(`${host} ${source} graphics during ${phase} reports the rejected source`, async () => {
        const fixture = fixtures.get(`${source}-${phase}`);
        if (host === "native") {
          const result = nativeResult(fixture);
          assert.equal(result.status, 1, result.stdout + result.stderr);
          assert.match(result.stderr + result.stdout, error);
        } else {
          await assert.rejects(
            () => (host === "browser" ? browserFrame(fixture) : runtimeFrame(fixture)),
            error,
          );
        }
      });
    }
  }
  test(`runtime unreadable graphics content ${id} during ${phase} names the id`, async () => {
    await assert.rejects(
      () => runtimeFrame(fixtures.get(`content-${phase}`), true),
      new RegExp(`content.*${id}|${id}.*content`, "i"),
    );
  });
}

for (const source of ["base64", "content", "buffer"]) {
  for (const phase of ["update", "draw"]) {
    test(`${source} graphics remain forbidden during ${phase}`, async () => {
      await assert.rejects(
        () => runtimeFrame(fixtures.get(`${source}-${phase}`), false, phase === "update"),
        /graphics assets are immutable after init/,
      );
    });
  }
}
