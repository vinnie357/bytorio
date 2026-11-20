import assert from "node:assert/strict";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { compileCli } from "./compile-cli.mjs";
import { requireCliHost } from "./host-platform.mjs";
import { repo, run, tool } from "./toolchain.mjs";
import { bundleLuau, odinEntry, odinGraphics } from "./sdk/bundle.mjs";
import { readGraphics } from "./sdk/assets.mjs";
import { encodeCartridge } from "./sdk/cartridge.mjs";
import { checkGame } from "./sdk/check.mjs";

const host = requireCliHost();
const output = resolve(repo, "build/cli-worker-verification");
await mkdir(output, { recursive: true });
const built = resolve(output, host.executable);
compileCli(["tools/cli/check-probe.mjs"], built);
const worker = resolve(output, "check-worker.mjs");
run(tool("bun"), ["build", "--target=bun", "tools/sdk/smoke-worker.mjs", "--outfile", worker]);

const temporaryRoot = resolve(tmpdir());
const sandbox = await mkdtemp(resolve(temporaryRoot, "byt-check-"));
assert.ok(sandbox.startsWith(temporaryRoot + sep), "Unexpected verification directory");
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^(path|mise.*|node.*|bun.*)$/i.test(name)),
);
environment.PATH = "";
const results = [];
try {
  const executable = resolve(sandbox, host.executable);
  await copyFile(built, executable);
  await writeFile(resolve(sandbox, ".env"), "NODE_OPTIONS=--invalid-byt-option\n");
  await writeFile(resolve(sandbox, "bunfig.toml"), 'preload = ["./missing.js"]\n');
  const payloadRoot = resolve(sandbox, "sdk payload with spaces");
  await mkdir(payloadRoot);
  await copyFile(worker, resolve(payloadRoot, "check-worker.mjs"));
  for (const [name, source] of [
    ["runtime.wasm", "build/odin-player/web/runtime.wasm"],
    ["executor.wasm", "build/luau-executor/luau-executor.wasm"],
  ]) {
    await copyFile(resolve(repo, source), resolve(payloadRoot, name));
  }
  const assetsPath = resolve(repo, "sdk/templates/assets.json");
  const assets = JSON.parse(await readFile(assetsPath, "utf8"));
  const { packet, palette } = await readGraphics(assetsPath);
  await cp(resolve(repo, "sdk/luau"), resolve(payloadRoot, "libraries"), { recursive: true });
  await copyFile(resolve(repo, "tests/sdk/game.luau"), resolve(payloadRoot, "main.luau"));
  const bundleRequest = {
    entry: resolve(payloadRoot, "main.luau"),
    project: payloadRoot,
    sdkRoot: resolve(payloadRoot, "libraries"),
    assets: packet.toString("base64"),
    palette,
    profile: 1,
    output: resolve(payloadRoot, "game.luau"),
    odinEntry: resolve(payloadRoot, "entry.odin"),
    odinGraphics: resolve(payloadRoot, "assets.odin"),
  };
  const requestPath = resolve(sandbox, "bundle.json");
  await writeFile(requestPath, JSON.stringify(bundleRequest));
  const bundled = spawnSync(executable, ["--bundle", requestPath], {
    cwd: sandbox,
    env: environment,
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
  assert.ifError(bundled.error);
  assert.equal(bundled.status, 0, bundled.stderr);
  assert.match(bundled.stdout, /Bundled SDK source/);
  const source = await readFile(bundleRequest.output);
  assert.deepEqual(source, await bundleLuau({ ...bundleRequest, assets: packet }));
  assert.equal(
    await readFile(bundleRequest.odinEntry, "utf8"),
    odinEntry({ graphicsImport: 'assets "./assets"' }),
  );
  assert.equal(
    await readFile(bundleRequest.odinGraphics, "utf8"),
    odinGraphics({ packet, palette }),
  );
  const contract = JSON.parse(await readFile(resolve(repo, "sdk/contract.json"), "utf8"));
  for (const name of ["game", "loop"]) {
    const sources = resolve(output, name);
    await mkdir(resolve(sources, "assets"), { recursive: true });
    await copyFile(bundleRequest.odinEntry, resolve(sources, "entry.odin"));
    await copyFile(bundleRequest.odinGraphics, resolve(sources, "assets/assets.odin"));
    await writeFile(
      resolve(sources, "game.odin"),
      name === "game"
        ? await readFile(resolve(repo, "tests/sdk/game.odin"))
        : "package main\ninit :: proc() {}\nupdate :: proc(dt: f64) { for {} }\ndraw :: proc() {}\n",
    );
    run(tool("odin"), [
      "build",
      sources,
      "-target:freestanding_wasm32",
      "-define:CONSOLE_PROFILE=1",
      "-no-entry-point",
      "-o:speed",
      "-source-code-locations:filename",
      `-collection:sdk=${resolve(repo, "sdk/odin")}`,
      `-out:${resolve(payloadRoot, `${name}.wasm`)}`,
      `-extra-linker-flags:--max-memory=${contract.limits.guestMemoryBytes}`,
    ]);
  }
  await writeFile(resolve(payloadRoot, "invalid.luau"), "this is not valid Luau !");
  await writeFile(resolve(payloadRoot, "invalid.wasm"), "not wasm");

  async function invoke(name, { game, source, expected }) {
    const language = source ? "luau" : "odin";
    const cartridge = resolve(payloadRoot, `${name}.png`);
    await writeFile(
      cartridge,
      encodeCartridge({
        title: "Standalone check fixture",
        language,
        display: [640, 360],
        code: await readFile(resolve(payloadRoot, source || game)),
        assets,
      }),
    );
    const request = resolve(sandbox, "request.json");
    const payload = {
      worker: resolve(payloadRoot, "check-worker.mjs"),
      runtime: resolve(payloadRoot, "runtime.wasm"),
      game: resolve(payloadRoot, game),
      source: source ? resolve(payloadRoot, source) : null,
      cartridge,
    };
    await writeFile(request, JSON.stringify(payload));
    if (expected) {
      await assert.rejects(checkGame(payload), expected, `${name}: source checker`);
    } else {
      await checkGame(payload);
    }
    const result = spawnSync(executable, [request], {
      cwd: sandbox,
      env: environment,
      encoding: "utf8",
      timeout: 20000,
      windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, `${name}: process crashed`);
    assert.equal(result.status, expected ? 1 : 0, `${name}: ${result.stderr}`);
    if (expected) {
      assert.match(result.stderr, expected, name);
      assert.doesNotMatch(result.stdout, /Checked packaged game/, name);
    } else {
      assert.match(result.stdout, /Checked packaged game/, name);
    }
    results.push({ name, exitCode: result.status });
  }
  await invoke("odin", { game: "game.wasm" });
  await invoke("luau", { game: "executor.wasm", source: "game.luau" });
  await invoke("invalid-wasm", { game: "invalid.wasm", expected: /Wasm|wasm|module/i });
  await invoke("invalid-luau", {
    game: "executor.wasm",
    source: "invalid.luau",
    expected: /Luau|compile|syntax/i,
  });
  await invoke("runaway", { game: "loop.wasm", expected: /stopped responding/ });
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        status: "passed",
        platform: host.id,
        isolatedCwd: true,
        emptyPath: true,
        standaloneSourceGeneration: true,
        results,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Packaged checking passed: real Odin/Luau Wasm, invalid guests and watchdog, isolated cwd and empty PATH.",
  );
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
