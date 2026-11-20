import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { chromium } from "./browser-timing.mjs";
import { createProject, buildProject, checkProject } from "./sdk/project.mjs";
import { bundleLuau } from "./sdk/bundle.mjs";
import { graphicsPacket } from "./sdk/assets.mjs";
import { serve } from "./serve.mjs";
import { nativePlayer, tool, run } from "./toolchain.mjs";
import {
  loadSource,
  checkExecutor,
  uploadGraphics,
  submitDrawing,
  rasterizeDrawing,
} from "../runtime/odin/web/policy.js";
const contract = JSON.parse(await readFile("sdk/contract.json", "utf8"));
const root = resolve("build/sdk-verification", randomUUID());
await mkdir(root, { recursive: true });
run(tool("odin"), [
  "test",
  "tests/sdk/input",
  "-o:none",
  `-out:${resolve(root, "input-tests.exe")}`,
]);
const paths = {};
for (const language of ["luau", "odin"]) {
  const path = resolve(root, language);
  await createProject(path, language);
  await copyFile(`tests/sdk/game.${language}`, resolve(path, `src/main.${language}`));
  await buildProject(path);
  for (const platform of ["web", "native"]) {
    const exported = resolve(path, "build", platform);
    if (language === "luau") {
      const executor = await readFile(resolve(exported, "luau-executor.wasm"));
      const version = JSON.parse(await readFile(resolve(exported, "executor-version.json")));
      assert.equal(version.sha256, createHash("sha256").update(executor).digest("hex"));
      for (const name of ["luau", "emscripten", "libcxx", "libcxxabi", "musl"]) {
        assert.ok((await readFile(resolve(exported, "licenses", `${name}.txt`))).length > 0);
      }
    } else {
      await assert.rejects(readFile(resolve(exported, "luau-executor.wasm")), {
        code: "ENOENT",
      });
    }
  }
  paths[language] = path;
}
const imports = {
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
};
const inputs = Array.from({ length: 120 }, (_, i) => ({
  buttons: ((i >= 5 && i < 15) || (i >= 45 && i < 48) ? 16 : 0) | (i >= 10 && i < 30 ? 2 : 0),
  pointer: (i >= 22 && i < 28) || i === 70,
  x: i === 70 ? 500 : 80.5,
  y: 60.75,
}));
for (const i of [80, 81]) {
  inputs[i].buttons = 0xffff0000;
}
inputs[83] = { buttons: 262144, pointer: false, x: 320, y: 60 };
inputs[84].buttons = 524288;
inputs[85].buttons = 1048576;
inputs[86] = { buttons: 65536 | 262144, pointer: true, x: 17.25, y: 18.5 };
async function pair(language) {
  const base = resolve(paths[language], "build/web");
  const bytes = await readFile(
    resolve(base, language === "luau" ? "luau-executor.wasm" : "game.wasm"),
  );
  const module = new WebAssembly.Module(bytes);
  assert.deepEqual(
    WebAssembly.Module.imports(module),
    language === "luau"
      ? [
          { module: "env", name: "content_size", kind: "function" },
          { module: "env", name: "content_read", kind: "function" },
          { module: "env", name: "save_size", kind: "function" },
          { module: "env", name: "save_status", kind: "function" },
          { module: "env", name: "save_read", kind: "function" },
          { module: "env", name: "text_configure", kind: "function" },
          { module: "env", name: "text_read", kind: "function" },
          { module: "env", name: "save_write", kind: "function" },
        ]
      : [],
    "SDK guest imports exactly its bounded host interfaces",
  );
  for (const name of Object.keys(contract.requiredExports)) {
    assert.ok(
      WebAssembly.Module.exports(module).some(
        (item) => item.kind === "function" && item.name === name,
      ),
      name,
    );
  }
  const game = (await WebAssembly.instantiate(module, imports)).exports;
  const runtime = (
    await WebAssembly.instantiate(await readFile(resolve(base, "runtime.wasm")), imports)
  ).instance.exports;
  game._initialize?.();
  if (language === "luau") {
    loadSource(game, await readFile(resolve(base, "game.luau")));
  }
  game.game_init();
  checkExecutor(game);
  runtime.runtime_init();
  uploadGraphics(game, runtime);
  assert.equal(game.game_sdk_version(), contract.sdkVersionWord);
  assert.equal(game.game_abi(), contract.abiVersion);
  assert.equal(game.game_frame_size(), contract.records.frame.bytes);
  assert.equal(game.game_command_stride(), contract.records.command.bytes);
  return { game, runtime };
}
function draw({ game, runtime }) {
  const drawing = submitDrawing(game, runtime);
  rasterizeDrawing(runtime, drawing);
  return {
    hash: runtime.runtime_hash() >>> 0,
    sounds: drawing.record.sounds,
    x: drawing.record.x,
    y: drawing.record.y,
    width: drawing.width,
    height: drawing.height,
    count: drawing.count,
  };
}
const expected = [];
for (const language of ["odin", "luau"]) {
  const p = await pair(language);
  assert.equal(draw(p).sounds, 1);
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    p.game.game_update(input.buttons, Number(input.pointer), input.x, input.y);
    checkExecutor(p.game);
    const frame = draw(p);
    assert.deepEqual(draw(p), frame, "draw is stable without another update");
    assert.equal(frame.width, (i >= 19 && i < 39) || i >= 59 ? 320 : 640);
    assert.equal(
      frame.y,
      i < 5 ? 0 : i < 15 ? 1 : i < 45 ? 11 : i < 48 ? 12 : 22,
      "pressed/released edges and held keys",
    );
    assert.equal(
      frame.sounds,
      i < 5 ? 1 : i < 45 ? 2 : i < 80 ? 3 : 4,
      "sound requests occur only on press edges",
    );
    if (i < 3) {
      assert.equal(
        frame.x,
        [31682556, 4018661298, 2101636938][i] % 1000,
        "known xorshift32 vector",
      );
    }
    if (language === "odin") {
      expected.push(frame);
    } else {
      assert.deepEqual(frame, expected[i], `SDK frame ${i}`);
    }
  }
  p.game.game_init();
  checkExecutor(p.game);
  assert.equal(draw(p).sounds, 1, "reload resets sound events");
  assert.equal(draw(p).width, 640, "reload resets display");
  // Versioned native replay exercises the same pointer and unsigned high-bit inputs.
  const nativeInputs = resolve(root, `${language}.inputs`);
  await writeFile(
    nativeInputs,
    inputs
      .map(({ buttons, pointer, x, y }) => `v2:${buttons}:${Number(pointer)}:${x}:${y}`)
      .join("\n") + "\n",
  );
  const replayPair = await pair(language);
  const nativeExpected = inputs.map((input) => {
    replayPair.game.game_update(input.buttons, Number(input.pointer), input.x, input.y);
    const f = draw(replayPair);
    return { hash: f.hash, sounds: f.sounds };
  });
  const base = resolve(paths[language], "build/native");
  const flags =
    language === "luau"
      ? ["--game", resolve(base, "luau-executor.wasm"), "--source", resolve(base, "game.luau")]
      : [];
  const result = spawnSync(resolve(base, nativePlayer), [...flags, "--replay", nativeInputs], {
    encoding: "utf8",
    timeout: 30000,
    cwd: base,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/).map(JSON.parse), nativeExpected);
  const smoke = spawnSync(resolve(base, nativePlayer), [...flags, "--smoke"], {
    encoding: "utf8",
    timeout: 30000,
    cwd: base,
    env: {
      ...process.env,
      SDL_VIDEODRIVER: "dummy",
      SDL_AUDIODRIVER: "dummy",
      SDL_RENDER_DRIVER: "software",
    },
  });
  assert.equal(smoke.status, 0, smoke.stderr);
  assert.ok(JSON.parse(smoke.stdout).audioQueuedFrames > 0);
}
const server = serve(root, 0);
await once(server, "listening");
const browser = await chromium.launch({
  channel: process.env.PLAYER_BROWSER_CHANNEL || "chrome",
  headless: true,
});
try {
  const page = await browser.newPage();
  for (const language of ["luau", "odin"]) {
    await page.goto(`http://127.0.0.1:${server.address().port}/${language}/build/web/debug.html`);
    await page.waitForFunction(() => playerStatus.ready || playerStatus.error);
    assert.equal(await page.evaluate(() => playerStatus.error), "");
    const frames = await page.evaluate(
      async ({ language, inputs }) => {
        const worker = new Worker("./worker.js", { type: "module" });
        const next = () =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Worker deadline")), 10000);
            worker.onmessage = ({ data }) => {
              if (data.type === "executing") {
                return;
              }
              clearTimeout(timer);
              if (data.type === "error") {
                reject(new Error(data.error));
              } else {
                resolve(data);
              }
            };
            worker.onerror = reject;
          });
        let pending = next();
        worker.postMessage({
          type: "load",
          gameUrl: language === "luau" ? "./game.luau" : "./game.wasm",
        });
        await pending;
        const frames = [];
        for (const input of inputs) {
          pending = next();
          worker.postMessage({ type: "step", steps: 1, render: false, input });
          const updated = await pending;
          if (updated.type !== "stepped") {
            throw new Error("Update-only request must not render");
          }
          pending = next();
          worker.postMessage({ type: "step", steps: 0, render: true });
          const f = await pending;
          if (f.ticks !== updated.ticks) {
            throw new Error("Draw-only request advanced the game");
          }
          pending = next();
          worker.postMessage({ type: "step", steps: 0, render: true });
          const repeated = await pending;
          if (
            repeated.ticks !== f.ticks ||
            repeated.hash !== f.hash ||
            repeated.sounds !== f.sounds
          ) {
            throw new Error("Repeated drawing changed game state or sound events");
          }
          frames.push({
            hash: f.hash,
            sounds: f.sounds,
            x: f.x,
            y: f.y,
            width: f.width,
            height: f.height,
          });
        }
        pending = next();
        worker.postMessage({
          type: "step",
          steps: 3,
          render: true,
          input: { buttons: 524288, pointer: false, x: 0, y: 0 },
        });
        const wheelFrame = await pending;
        if (wheelFrame.sounds !== 5 || wheelFrame.ticks !== 123) {
          throw new Error("Wheel input must be consumed once across catch-up simulation ticks");
        }
        worker.terminate();
        return frames;
      },
      { language, inputs },
    );
    assert.deepEqual(
      frames,
      expected.map(({ count, ...frame }) => frame),
    );
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
// SDK error behavior, caught independently of rendering and reset on reload.
const luau = await pair("luau");
// Getter calls may grow memory after draw; the submitted frame must be a snapshot.
const growing = new WebAssembly.Memory({ initial: 1, maximum: 2 });
const frameView = new DataView(growing.buffer);
frameView.setUint32(0, 1, true);
frameView.setUint32(4, 0xff102030, true);
frameView.setInt32(8, -4096, true);
frameView.setInt32(12, -4096, true);
const mock = {
  memory: growing,
  game_draw: () => 0,
  game_display_mode: () => {
    growing.grow(1);
    return (640 << 16) | 360;
  },
};
const copied = submitDrawing(mock, luau.runtime);
rasterizeDrawing(luau.runtime, copied);
assert.equal(
  new Uint32Array(luau.runtime.memory.buffer, luau.runtime.runtime_pixels(), 1)[0],
  0xff102030,
  "frame survives memory growth",
);
const runtimeFrame = new DataView(luau.runtime.memory.buffer, luau.runtime.runtime_frame(), 40);
runtimeFrame.setUint32(4, 0, true);
assert.equal(luau.runtime.runtime_render(), 0, "host rejects nonopaque clear");
runtimeFrame.setUint32(4, 0xff102030, true);
const command = new DataView(luau.runtime.memory.buffer, luau.runtime.runtime_batch(), 32);
for (let i = 0; i < 32; i += 4) {
  command.setUint32(i, 0, true);
}
command.setInt32(12, 1, true);
command.setInt32(16, 1, true);
assert.equal(luau.runtime.runtime_render_batch(1, 0), 0, "host rejects nonopaque rect");
command.setUint32(0, 3, true);
command.setInt32(12, 129, true);
assert.equal(luau.runtime.runtime_render_batch(1, 0), 0, "host rejects oversized resampling");
for (const statement of [
  "byt.sprite(0,0,0,0)",
  'byt.text("é",0,0,byt.rgb(1,2,3))',
  "byt.rect(0,0,-1,1,byt.rgb(1,2,3))",
]) {
  const main = resolve(paths.luau, "src/main.luau");
  await writeFile(
    main,
    `local byt=require("@bytorio")\nreturn {init=function() end,update=function() end,draw=function() ${statement} end}\n`,
  );
  const { packet } = graphicsPacket(
    JSON.parse(await readFile(resolve(paths.luau, "assets.json"), "utf8")),
  );
  const source = await bundleLuau({
    entry: main,
    project: paths.luau,
    sdkRoot: resolve("sdk/luau"),
    assets: packet,
  });
  loadSource(luau.game, source);
  luau.game.game_init();
  checkExecutor(luau.game);
  luau.game.game_draw();
  assert.throws(() => checkExecutor(luau.game));
  const length = luau.game.game_error_length();
  luau.game.game_update(0, 0, 0, 0);
  assert.equal(luau.game.game_error_length(), length);
}
// Static checking catches language API misuse before creating a cartridge.
await writeFile(
  resolve(paths.luau, "src/main.luau"),
  '--!strict\nlocal byt=require("@bytorio")\nbyt.button("jump")\nreturn {}\n',
);
await assert.rejects(() => checkProject(paths.luau), /failed/);
await writeFile(
  resolve(paths.odin, "src/main.odin"),
  'package main\nimport byt "sdk:bytorio"\ninit :: proc(){_=byt.button(.Jump)}\nupdate :: proc(dt:f64){}\ndraw :: proc(){}\n',
);
await assert.rejects(() => checkProject(paths.odin), /failed/);
for (const statement of [
  "byt.sprite(0,0,0,0)",
  'byt.text("é",0,0,byt.rgb(1,2,3))',
  "byt.rect(0,0,-1,1,byt.rgb(1,2,3))",
]) {
  await writeFile(
    resolve(paths.odin, "src/main.odin"),
    `package main\nimport byt "sdk:bytorio"\ninit :: proc(){}\nupdate :: proc(dt:f64){}\ndraw :: proc(){${statement}}\n`,
  );
  await assert.rejects(() => checkProject(paths.odin), /invalid sprite|ASCII|rectangle dimensions/);
  const game = (
    await WebAssembly.instantiate(await readFile(resolve(paths.odin, "build/generated/game.wasm")))
  ).instance.exports;
  game.game_init();
  assert.equal(game.game_error_length(), 0);
  game.game_draw();
  const length = game.game_error_length();
  assert.ok(length > 0);
  game.game_update(0, 0, 0, 0);
  assert.equal(game.game_error_length(), length);
  game.game_init();
  assert.equal(game.game_error_length(), 0);
}
await writeFile(
  resolve(paths.luau, "src/main.luau"),
  "--!strict\nreturn {init=function() while true do end end,update=function(_dt:number) end,draw=function() end}\n",
);
await assert.rejects(() => checkProject(paths.luau), /stopped responding/);
const sample = JSON.parse(await readFile(resolve(paths.luau, "assets.json"), "utf8"));
sample.sprites[0][0] = "bad";
assert.throws(() => graphicsPacket(sample), /width/);
await writeFile(resolve(paths.luau, "src/main.luau"), 'local m=require("../outside")\nreturn m');
await assert.rejects(
  () =>
    bundleLuau({
      entry: resolve(paths.luau, "src/main.luau"),
      project: paths.luau,
      sdkRoot: resolve("sdk/luau"),
      assets: Buffer.alloc(0),
    }),
  /Missing module|escapes/,
);
console.log(
  "SDK conformance passed: strict authoring, ABI exports, 120-frame native/browser parity, input edges, pointer, random vectors, modes, drawing, audio, reload and validation.",
);
