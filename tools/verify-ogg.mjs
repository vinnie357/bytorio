import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { once } from "node:events";
import { createProject, buildProject, requireNativePlayer } from "./sdk/project.mjs";
import {
  tool,
  run,
  task,
  dependencyRoot,
  copyWasmtimeLibrary,
  nativePlayer,
} from "./toolchain.mjs";
import { chromium } from "./browser-timing.mjs";
import { serve } from "./serve.mjs";
import { odinUnitTests } from "./odin-unit-tests.mjs";
requireNativePlayer();

const root = resolve("build/ogg-verification");
await mkdir(root, { recursive: true });
await writeFile(
  resolve(root, "lifecycle.log"),
  odinUnitTests("tests/resources/ogg", resolve(root, "lifecycle.exe")),
);
task("build:odin");
run(tool("odin"), [
  "build",
  "tests/ogg/player",
  "-o:speed",
  `-collection:deps=${dependencyRoot()}`,
  `-out:${resolve(root, "trace.exe")}`,
]);
await copyWasmtimeLibrary(root);
const referenceBytes = await readFile("tests/ogg/fixtures/reference.f32");
const reference = new Float32Array(
  referenceBytes.buffer,
  referenceBytes.byteOffset,
  referenceBytes.length / 4,
);
function checkPcm(bytes) {
  const pcm = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  let maxError = 0;
  for (let frame = 0; frame < pcm.length / 2; frame++) {
    const logical = frame - 2400;
    // FFmpeg trims the encoder's final 128 frames; other independent samples remain checked.
    if (logical >= reference.length / 2 && logical < 24000) {
      continue;
    }
    const loop = logical < 4199 ? logical : 431 + ((logical - 4199) % (4199 - 431));
    for (let channel = 0; channel < 2; channel++) {
      const expected =
        logical < 0
          ? 0
          : reference[loop * 2 + channel] * 0.5 +
            reference[Math.min(logical, 431) * 2 + channel] * 0.125 +
            (logical < reference.length / 2 ? reference[logical * 2 + channel] * 0.25 : 0);
      maxError = Math.max(maxError, Math.abs(pcm[frame * 2 + channel] - expected));
    }
  }
  assert.ok(maxError < 0.000002, `independent PCM reference error ${maxError}`);
  return maxError;
}
const report = {};
const browser = await chromium.launch({
  channel: process.env.PLAYER_BROWSER_CHANNEL || "chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
try {
  for (const language of ["odin", "luau"]) {
    const project = resolve(root, language);
    try {
      await createProject(project, language);
    } catch (error) {
      if (!String(error).includes("exist")) {
        throw error;
      }
    }
    await copyFile(`tests/ogg/game.${language}`, resolve(project, `src/main.${language}`));
    await copyFile("tests/ogg/fixtures/tone.ogg", resolve(project, "tone.ogg"));
    const manifestPath = resolve(project, "console.json");
    const manifest = JSON.parse(await readFile(manifestPath));
    Object.assign(manifest, {
      sdk: "0.7.0",
      profile: "ogg-streaming-preview-1",
      content: [{ id: 1, path: "tone.ogg" }],
    });
    await writeFile(manifestPath, JSON.stringify(manifest));
    await buildProject(project);
    const web = resolve(project, "build/web");
    const nativePath = resolve(root, `${language}.f32`);
    const native = JSON.parse(
      run(resolve(root, "trace.exe"), [
        resolve(web, "game.png"),
        resolve(web, "luau-executor.wasm"),
        nativePath,
      ]),
    );
    assert.equal(native.underruns, 0);
    assert.equal(native.late, 0);
    assert.equal(native.rejected, 0);
    assert.equal(native.completed, 1);
    assert.ok(native.resourceBytes < 64 * 1024 * 1024);
    const device = JSON.parse(
      run(resolve(project, "build/native", nativePlayer), ["--smoke"], {
        env: {
          ...process.env,
          SDL_VIDEODRIVER: "dummy",
          SDL_AUDIODRIVER: "dummy",
          SDL_RENDER_DRIVER: "software",
        },
      }),
    );
    assert.ok(device.audioMixerFrame > 0, "standalone SDL callback consumes the Ogg stream");
    native.deviceFrames = device.audioMixerFrame;
    const nativeBytes = await readFile(nativePath);
    native.referenceError = checkPcm(nativeBytes);
    await copyFile("tests/ogg/worker.js", resolve(web, "ogg-test-worker.js"));
    await writeFile(resolve(web, "ogg-test.html"), "<!doctype html><title>Ogg conformance</title>");
    const server = serve(web, 0);
    await once(server, "listening");
    const page = await browser.newPage();
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      await page.goto(`${origin}/ogg-test.html`);
      const result = await page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const worker = new Worker("./ogg-test-worker.js", { type: "module" });
            worker.onerror = (event) => reject(new Error(event.message));
            worker.onmessage = ({ data }) => {
              worker.terminate();
              if (data.error) {
                return reject(new Error(data.error));
              }
              const bytes = new Uint8Array(data.pcm);
              let text = "";
              for (let at = 0; at < bytes.length; at += 8192) {
                text += String.fromCharCode(...bytes.subarray(at, at + 8192));
              }
              resolve({ pcm: btoa(text), memoryBytes: data.memoryBytes });
            };
            worker.postMessage({});
          }),
      );
      const browserBytes = Buffer.from(result.pcm, "base64");
      const browserError = checkPcm(browserBytes);
      assert.equal(result.memoryBytes, 8 * 1024 * 1024);
      let parityError = 0;
      for (let at = 0; at < browserBytes.length; at += 4) {
        parityError = Math.max(
          parityError,
          Math.abs(browserBytes.readFloatLE(at) - nativeBytes.readFloatLE(at)),
        );
      }
      assert.ok(parityError < 0.000002);
      report[language] = {
        native,
        browserError,
        parityError,
        decoderMemoryBytes: result.memoryBytes,
      };
      await page.goto(`${origin}/player.html`);
      await page.waitForFunction(() => playerStatus.ready || playerStatus.error);
      assert.equal(await page.evaluate(() => playerStatus.error), "");
      await page.click("#start");
      await page.waitForFunction(() => playerAudio.mixerStatus?.frame > 12000);
      const before = await page.evaluate(() => playerAudio.mixerStatus);
      await page.evaluate(() => {
        const start = performance.now();
        while (performance.now() - start < 500) {
          /* Deliberately block the UI. */
        }
      });
      await page.waitForFunction(
        (frame) => playerAudio.mixerStatus?.frame > frame + 24000,
        before.frame,
      );
      const after = await page.evaluate(() => ({
        ...playerAudio.mixerStatus,
        error: playerStatus.error,
      }));
      assert.equal(after.error, "");
      assert.equal(after.underrunFrames, 0);
      assert.equal(after.rejectedWrites, 0);
      report[language].mainThreadStall = {
        durationMs: 500,
        advancedFrames: after.frame - before.frame,
        underruns: after.underrunFrames,
      };
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await page.waitForTimeout(150);
      const paused = await page.evaluate(() => playerAudio.mixerStatus.frame);
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => playerAudio.mixerStatus.frame), paused);
      await page.click("#start");
      await page.waitForFunction((frame) => playerAudio.mixerStatus.frame > frame, paused);
      await page.setInputFiles("#cartridge", resolve(web, "game.png"));
      await page.waitForFunction(() => playerStatus.ready && !playerAudio.mixerStatus);
      await page.click("#start");
      await page.waitForFunction(() => playerAudio.mixerStatus?.frame > 5000);
      assert.equal(await page.evaluate(() => playerAudio.mixerStatus.underrunFrames), 0);
    } finally {
      await page.close();
      server.close();
      await once(server, "close");
    }
  }
} finally {
  await browser.close();
}
await writeFile(resolve(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
