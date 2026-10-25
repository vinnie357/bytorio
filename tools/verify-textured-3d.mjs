import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";
import { chromium } from "./browser-timing.mjs";
import { createProject, buildProject, requireNativePlayer } from "./sdk/project.mjs";
import {
  configureResources,
  submitResources,
  loadSource,
  checkExecutor,
  negotiateProfile,
  submitDrawing,
  rasterizeDrawing,
  uploadGraphics,
} from "../runtime/odin/web/policy.js";
import {
  FNV1A_OFFSET_BASIS,
  FNV1A_PRIME,
  RESOURCE_EXPORTS,
} from "../runtime/odin/web/constants.js";
import { run, task, copyWasmtimeLibrary, nativePlayer } from "./toolchain.mjs";
import { odinUnitTests } from "./odin-unit-tests.mjs";
import { serve } from "./serve.mjs";
import { buildTexturedDrawing } from "./build-textured-3d.mjs";
requireNativePlayer();

const root = resolve("build/textured-3d-verification", randomUUID());
const profile = JSON.parse(await readFile("sdk/profiles/textured-3d-preview-1.json"));
const baseProfile = JSON.parse(await readFile("sdk/profiles/compact-3d-preview-1.json"));
assert.deepEqual(
  [
    profile.profileId,
    profile.sdkVersionWord,
    profile.abiVersion,
    profile.protocolVersion,
    profile.requiredFeatures,
  ],
  [4, 1024, 2, 6, 31],
);
for (const [name, value] of Object.entries(baseProfile.targets)) {
  assert.equal(profile.targets[name], value, `unchanged resource limit ${name}`);
}
assert.equal(profile.targets.maxTextureCoordinate, 1024);
await mkdir(root, { recursive: true });
await writeFile(
  resolve(root, "harness.html"),
  "<!doctype html><title>Textured resource verification</title>",
);
odinUnitTests("tests/3d", resolve(root, "unit.exe"));
task("deps:trace:resources");
await copyFile("build/validation-tools/resources/trace.exe", resolve(root, "trace.exe"));
await copyWasmtimeLibrary(root);

const advertised = {
  ...Object.fromEntries(RESOURCE_EXPORTS.map(({ name }) => [name, () => 0])),
  game_profile: () => 4,
  game_abi: () => 2,
  game_sdk_version: () => 1024,
  game_resource_protocol: () => 6,
  game_required_features: () => 31,
  game_frame_size: () => 40,
};
assert.equal(negotiateProfile(advertised), 4);
for (const [field, wrong] of [
  ["game_abi", 1],
  ["game_sdk_version", 768],
  ["game_resource_protocol", 5],
  ["game_required_features", 15],
  ["game_profile", 3],
]) {
  assert.throws(() => negotiateProfile({ ...advertised, [field]: () => wrong }), /Unsupported/);
}

function expectedHash(generation, texel) {
  const parts = [];
  const slot = (index, kind, format, width, height, data) => {
    const metadata = Buffer.alloc(28);
    [generation * 65536 + index, kind, format, width, height, 0, 0].forEach((v, i) =>
      metadata.writeUInt32LE(v, i * 4),
    );
    parts.push(metadata, data);
  };
  slot(1, 1, 2, 2, 2, Buffer.alloc(16, texel));
  const geometry = Buffer.alloc(84);
  const vertices = [
    [-1, -1, 0.5, 0xffffffff, -0.25, 0],
    [1, -1, 0.5, 0xff0000ff, 1.25, 0],
    [0, 1, 0.5, 0xff00ff00, 0.5, 1],
  ];
  vertices.forEach((v, i) =>
    v.forEach((value, j) =>
      j === 3
        ? geometry.writeUInt32LE(value, i * 24 + j * 4)
        : geometry.writeFloatLE(value, i * 24 + j * 4),
    ),
  );
  [0, 1, 2].forEach((v, i) => geometry.writeUInt32LE(v, 72 + i * 4));
  slot(2, 18, 0, 0, 0, geometry);
  const material = Buffer.alloc(32);
  material.writeUInt32LE(generation * 65536 + 1, 0);
  material.writeUInt32LE(1, 4);
  slot(3, 17, 0, 0, 0, material);
  return Buffer.concat(parts).reduce(
    (hash, byte) => Math.imul(hash ^ byte, FNV1A_PRIME) >>> 0,
    FNV1A_OFFSET_BASIS,
  );
}

const projects = {};
let reference;
for (const language of ["odin", "luau"]) {
  const project = resolve(root, language);
  await createProject(project, language);
  const manifest = JSON.parse(await readFile(resolve(project, "console.json")));
  Object.assign(manifest, { sdk: "0.4.0", profile: "textured-3d-preview-1" });
  await writeFile(resolve(project, "console.json"), JSON.stringify(manifest, null, 2));
  await copyFile(
    `tests/textured3d/cartridges/lifecycle.${language}`,
    resolve(project, `src/main.${language}`),
  );
  await buildProject(project);
  projects[language] = project;
  const base = resolve(project, "build/web");
  const wasm = resolve(base, language === "luau" ? "luau-executor.wasm" : "game.wasm");
  const source = language === "luau" ? resolve(base, "game.luau") : null;
  const game = (
    await WebAssembly.instantiate(await readFile(wasm), {
      env: {
        sin: Math.sin,
        content_size: () => 0,
        content_read: () => 0,
        save_size: () => 0,
        save_status: () => 3,
        save_read: () => 0,
        save_write: () => 3,
        text_configure: () => 0,
        text_read: () => 0,
      },
    })
  ).instance.exports;
  const bytes = await readFile(resolve(base, "runtime.wasm"));
  const runtime = (
    await WebAssembly.instantiate(bytes, {
      env: {
        sin: Math.sin,
        content_size: () => 0,
        content_read: () => 0,
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
  if (source) {
    loadSource(game, await readFile(source));
  }
  configureResources(game, runtime);
  game.game_init();
  checkExecutor(game);
  const packet = new Uint8Array(
    game.memory.buffer,
    game.game_commit(),
    game.game_commit_size(),
  ).slice();
  const header = new DataView(packet.buffer);
  assert.equal(header.getUint32(32, true), 4);
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => header.getUint16(64 + i * 32, true)),
    [1, 3, 71, 72],
  );
  const payload = header.getUint32(44, true);
  const meshData = payload + header.getUint32(64 + 2 * 32 + 20, true);
  const materialArgs = payload + header.getUint32(64 + 3 * 32 + 12, true);
  for (const [name, mutation] of [
    ["NaN UV", (view) => view.setUint32(meshData + 16, 0x7fc00000, true)],
    ["oversized UV", (view) => view.setFloat32(meshData + 20, 1025, true)],
    ["index bounds", (view) => view.setUint32(meshData + 72, 3, true)],
    ["bad sampler", (view) => view.setUint32(materialArgs + 4, 2, true)],
    ["wrong texture kind", (view) => view.setUint32(materialArgs, 65538, true)],
    ["material padding", (view) => view.setUint32(materialArgs + 12, 1, true)],
  ]) {
    const invalid = packet.slice();
    mutation(new DataView(invalid.buffer));
    new Uint8Array(runtime.memory.buffer, runtime.runtime_resource_packet(), invalid.length).set(
      invalid,
    );
    assert.equal(runtime.runtime_resource_submit(invalid.length), 0, name);
    assert.equal(runtime.runtime_resource_bytes(), 0, `${name}: rollback`);
  }
  for (const protocol of [4, 5]) {
    const old = (
      await WebAssembly.instantiate(bytes, {
        env: {
          sin: Math.sin,
          content_size: () => 0,
          content_read: () => 0,
          save_size: () => 0,
          save_status: () => 3,
          save_read: () => 0,
          save_write: () => 3,
          text_configure: () => 0,
          text_read: () => 0,
        },
      })
    ).instance.exports;
    assert.equal(old.runtime_resource_reset(protocol), 1);
    new Uint8Array(old.memory.buffer, old.runtime_resource_packet(), packet.length).set(packet);
    assert.equal(
      old.runtime_resource_submit(packet.length),
      0,
      "old profiles reject new resources",
    );
    assert.equal(old.runtime_resource_bytes(), 0);
    old.runtime_resource_close();
  }
  new Uint8Array(runtime.memory.buffer, runtime.runtime_resource_packet(), packet.length).set(
    packet,
  );
  assert.equal(runtime.runtime_resource_submit(packet.length), 1);
  assert.equal(game.game_commit_ack(header.getUint32(28, true)), 1);
  const state = () => [runtime.runtime_resource_hash() >>> 0, runtime.runtime_resource_bytes()];
  const trace = [state()];
  assert.deepEqual(trace[0], [expectedHash(1, 255), 132]);
  for (let tick = 1; tick <= 120; tick++) {
    game.game_update(0, 0, 0, 0);
    checkExecutor(game);
    submitResources(game, runtime);
    trace.push(state());
  }
  assert.deepEqual(trace[2], [expectedHash(1, 128), 132]);
  assert.deepEqual(trace[3], [FNV1A_OFFSET_BASIS, 0]);
  assert.deepEqual(trace[4], [expectedHash(2, 255), 132]);
  const native = run(resolve(root, "trace.exe"), [wasm, source || ""])
    .trim()
    .split(/\r?\n/)
    .map((row) => row.split(" ").map(Number));
  assert.deepEqual(native, trace, `${language}: native registry trace`);
  const standalone = JSON.parse(run(resolve(project, "build/native", nativePlayer), ["--check"]));
  assert.equal(standalone.resourceHash, trace[120][0]);
  assert.equal(standalone.resourceBytes, 132);
  if (reference) {
    assert.deepEqual(trace, reference, "SDK lifecycle parity");
  } else {
    reference = trace;
  }
  runtime.runtime_resource_close();
}

const server = serve(".", 0);
await once(server, "listening");
const browser = await chromium.launch({
  channel: process.env.PLAYER_BROWSER_CHANNEL || undefined,
});
try {
  const page = await browser.newPage();
  await page.goto(
    `http://127.0.0.1:${server.address().port}/${relative(process.cwd(), root).replaceAll("\\", "/")}/harness.html`,
  );
  for (const language of ["odin", "luau"]) {
    const base =
      "/" + relative(process.cwd(), resolve(projects[language], "build/web")).replaceAll("\\", "/");
    for (const png of [false, true]) {
      const trace = await page.evaluate(
        async ({ base, language, png }) => {
          const worker = new Worker(base + "/worker.js", { type: "module" });
          const request = (message, expected) =>
            new Promise((resolve, reject) => {
              const timer = setTimeout(
                () => reject(new Error("Textured resource worker deadline")),
                20000,
              );
              worker.onerror = (e) => {
                clearTimeout(timer);
                reject(new Error(e.message));
              };
              worker.onmessage = async ({ data }) => {
                if (data.type === "executor") {
                  const bytes = await (await fetch(base + "/luau-executor.wasm")).arrayBuffer();
                  worker.postMessage({ type: "executor", executor: { bytes } }, [bytes]);
                } else if (data.type === "error") {
                  clearTimeout(timer);
                  reject(new Error(data.error));
                } else if (data.type === expected) {
                  data.bitmap?.close();
                  clearTimeout(timer);
                  resolve([data.resourceHash, data.resourceBytes]);
                }
              };
              worker.postMessage(message);
            });
          try {
            const load = {
              type: "load",
              resourceTrace: true,
              gameUrl:
                location.origin +
                base +
                (png ? "/game.png" : language === "luau" ? "/game.luau" : "/game.wasm"),
            };
            const trace = [await request(load, "ready")];
            for (let tick = 0; tick < 8; tick++) {
              trace.push(
                await request(
                  {
                    type: "step",
                    steps: 1,
                    input: { buttons: 0, pointer: false, x: 0, y: 0 },
                  },
                  "frame",
                ),
              );
            }
            if ((await request(load, "ready"))[0] !== trace[0][0]) {
              throw new Error("resource reload did not reset handles");
            }
            return trace;
          } finally {
            worker.terminate();
          }
        },
        { base, language, png },
      );
      assert.deepEqual(
        trace,
        reference.slice(0, 9),
        `${language}/${png ? "PNG" : "loose"}: browser registry trace`,
      );
    }
  }
  for (const { language, project } of await buildTexturedDrawing(resolve(root, "drawing"))) {
    const web = resolve(project, "build/web");
    const instantiate = async (file) =>
      (
        await WebAssembly.instantiate(await readFile(file), {
          env: {
            sin: Math.sin,
            content_size: () => 0,
            content_read: () => 0,
            save_size: () => 0,
            save_status: () => 3,
            save_read: () => 0,
            save_write: () => 3,
            text_configure: () => 0,
            text_read: () => 0,
          },
        })
      ).instance.exports;
    const game = await instantiate(
      resolve(web, language === "luau" ? "luau-executor.wasm" : "game.wasm"),
    );
    const runtime = await instantiate(resolve(web, "runtime.wasm"));
    game._initialize?.();
    if (language === "luau") {
      loadSource(game, await readFile(resolve(web, "game.luau")));
    }
    configureResources(game, runtime);
    game.game_init();
    checkExecutor(game);
    submitResources(game, runtime);
    uploadGraphics(game, runtime);
    const drawing = submitDrawing(game, runtime);
    rasterizeDrawing(runtime, drawing);
    const pixels = new DataView(
      runtime.memory.buffer,
      runtime.runtime_logical_pixels(),
      320 * 180 * 4,
    );
    assert.equal(
      pixels.getUint32((90 * 320 + 160) * 4, true),
      0xff00ff00,
      `${language}: perspective UV sample`,
    );
    assert.equal(pixels.getUint32(0, true), 0xff222222, `${language}: background`);
    const expected = runtime.runtime_hash() >>> 0;
    const native = JSON.parse(run(resolve(project, "build/native", nativePlayer), ["--check"]));
    assert.equal(native.hash, expected, `${language}: standalone textured pixels`);
    const base = "/" + relative(process.cwd(), web).replaceAll("\\", "/");
    for (const gameFile of ["game.png", language === "luau" ? "game.luau" : "game.wasm"]) {
      await page.goto(
        `http://127.0.0.1:${server.address().port}${base}/player.html?game=./${gameFile}&smoke`,
      );
      await page.waitForFunction(() => window.playerStatus?.ready || window.playerStatus?.error);
      assert.equal(await page.evaluate(() => window.playerStatus.error), "");
      await page.locator("#start").click();
      await page.waitForFunction(
        () => window.playerStatus.ticks >= 120 || window.playerStatus.error,
      );
      assert.equal(await page.evaluate(() => window.playerStatus.error), "");
      assert.equal(
        await page.evaluate(() => window.playerStatus.hash),
        expected,
        `${language}/${gameFile}: browser textured pixels`,
      );
    }
    runtime.runtime_resource_close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
await writeFile(
  resolve(root, "report.json"),
  JSON.stringify(
    {
      status: "passed",
      scope: "typed resources and profile lifecycle",
      languages: Object.keys(projects),
      frames: reference.length,
      trace: reference,
    },
    null,
    2,
  ),
);
console.log(
  "Textured 3D lifecycle passed: both SDKs, native/browser, PNG/loose negotiation, independent bytes, ownership, rollback and reload.",
);
