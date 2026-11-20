/* global startupObservation */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { createProject, buildProject } from "./sdk/project.mjs";
import { chromium } from "./browser-timing.mjs";
import { minimumDelay } from "./test-clock.mjs";

const root = resolve("build/ogg-startup-verification", randomUUID());
const project = resolve(root, "fixture");
await mkdir(root, { recursive: true });
await createProject(project, "odin");
await copyFile("tests/ogg-startup/game.odin", resolve(project, "src/main.odin"));
await copyFile("tests/ogg/fixtures/tone.ogg", resolve(project, "tone.ogg"));
const manifest = JSON.parse(await readFile(resolve(project, "console.json")));
Object.assign(manifest, {
  sdk: "0.7.0",
  profile: "ogg-streaming-preview-1",
  content: [{ id: 1, path: "tone.ogg" }],
});
await writeFile(resolve(project, "console.json"), JSON.stringify(manifest, null, 2));
await buildProject(project);
const web = resolve(project, "build/web");
const worker = await readFile(resolve(web, "worker.js"), "utf8");
const warmup =
  'await prepareOggDecoder(() => fetchBytes("./vorbis.wasm", undefined, reportProgress));';
assert.equal(worker.split(warmup).length, 2, "Exactly one pre-execution decoder warmup seam");
const worklet = await readFile(resolve(web, "audio-worklet.js"), "utf8");
const registration = 'registerProcessor("console-pcm-mixer", MixerProcessor);';
assert.equal(worklet.split(registration).length, 2, "One actual mixer registration");
const observer = await readFile("tests/ogg-startup/worklet-observer.js", "utf8");
const observedWorklet = worklet.replace(registration, observer);
const referenceBytes = await readFile("tests/ogg/fixtures/reference.f32");
const reference = new Float32Array(
  referenceBytes.buffer,
  referenceBytes.byteOffset,
  referenceBytes.length / 4,
);
const transfers = [];
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const [, mode, ...parts] = pathname.split("/");
    assert(["red", "green"].includes(mode));
    const name = parts.join("/") || "debug.html";
    const path = resolve(web, name);
    assert(path.startsWith(web + sep));
    let bytes = await readFile(path);
    if (name === "worker.js" && mode === "red") {
      bytes = Buffer.from(worker.replace(warmup, "/* RED: omit only pre-execution warmup. */"));
    } else if (name === "audio-worklet.js") {
      bytes = Buffer.from(observedWorklet);
    }
    if (name === "vorbis.wasm") {
      const transfer = { mode, requested: Date.now(), delivered: null, bytes: bytes.length };
      transfers.push(transfer);
      transfer.durationMs = await minimumDelay(350);
      transfer.delivered = Date.now();
    }
    const types = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };
    response.writeHead(200, {
      "Content-Type": types[extname(name)] || "application/octet-stream",
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
  workerSha256: createHash("sha256").update(worker).digest("hex"),
  scope:
    "Actual SDK profile-7 cartridge, production browser player/worker and real AudioWorklet clock. Only the real Vorbis wasm HTTP response is delayed 350 ms. RED copied worker omits pre-execution warmup. A read-only copied worklet observer captures rendered PCM; production files remain unchanged.",
  cases: [],
  transfers,
};
let browser;
try {
  browser = await chromium.launch({
    channel: process.env.PLAYER_BROWSER_CHANNEL || undefined,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  for (const mode of ["red", "green"]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      globalThis.startupObservation = { ready: null, pcm: null };
      const OriginalContext = globalThis.AudioContext;
      globalThis.AudioContext = class extends OriginalContext {
        constructor(options) {
          super({ ...options, sampleRate: 48000 });
        }
      };
      const OriginalNode = globalThis.AudioWorkletNode;
      globalThis.AudioWorkletNode = class extends OriginalNode {
        constructor(...args) {
          super(...args);
          this.port.addEventListener("message", ({ data }) => {
            if (data.type === "startup-pcm") {
              startupObservation.pcm = data.buffer;
            }
          });
        }
      };
      const OriginalWorker = globalThis.Worker;
      globalThis.Worker = class extends OriginalWorker {
        constructor(...args) {
          super(...args);
          this.addEventListener("message", ({ data }) => {
            if (data.type === "ready") {
              startupObservation.ready = { time: Date.now(), memory: data.memory };
            }
          });
        }
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/${mode}/debug.html`);
    await page.waitForFunction(() => playerStatus.ready || playerStatus.error);
    const ready = await page.evaluate(() => ({
      ...startupObservation.ready,
      error: playerStatus.error,
    }));
    assert.equal(ready.error, "");
    assert.equal(ready.memory.vorbisLinear, 0, "Warmup must not instantiate a decoder heap");
    const started = Date.now();
    await page.click("#start");
    await page.waitForFunction(() => startupObservation.pcm || playerStatus.error);
    const result = await page.evaluate(() => {
      const bytes = new Uint8Array(startupObservation.pcm || new ArrayBuffer(0));
      let encoded = "";
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        encoded += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      }
      return {
        status: { ...playerStatus },
        mixer: playerAudio.mixerStatus,
        pcm: btoa(encoded),
      };
    });
    const pcmBytes = Buffer.from(result.pcm, "base64");
    delete result.pcm;
    await writeFile(resolve(root, `${mode}.f32`), pcmBytes);
    const item = { mode, ready, started, ...result, errors };
    report.cases.push(item);
    assert.equal(result.status.error, "");
    assert.deepEqual(errors, []);
    assert.equal(result.mixer.deviceRate, 48000);
    assert.equal(result.mixer.completed, 1, "The complete finite tone must finish");
    assert.equal(result.mixer.rejectedWrites, 0);
    const transfer = transfers.filter((entry) => entry.mode === mode);
    assert.equal(transfer.length, 1, "Exactly one actual decoder download");
    assert(transfer[0].durationMs >= 350, "The real decoder response is delayed at least 350 ms");
    if (mode === "red") {
      assert(transfer[0].requested >= started, "RED decoder stays lazy until playback");
      assert(result.mixer.underrunFrames > 0, "The omitted warmup must reproduce a real underrun");
    } else {
      assert(
        transfer[0].delivered <= ready.time,
        "The decoder code is ready before guest execution",
      );
      assert.equal(result.mixer.underrunFrames, 0);
      assert.equal(result.mixer.lateEvents, 0);
      const pcm = new Float32Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.length / 4);
      const firstSample = pcm.findIndex((value) => Math.abs(value) > 0.00001);
      const referenceFirst = reference.findIndex((value) => Math.abs(value * 0.5) > 0.00001);
      assert(firstSample >= 0 && referenceFirst >= 0, "The real output contains the decoded tone");
      const offset = firstSample - referenceFirst;
      assert(offset >= 0 && offset + reference.length <= pcm.length);
      let maxError = 0;
      for (let sample = 0; sample < reference.length; sample++) {
        maxError = Math.max(maxError, Math.abs(pcm[offset + sample] - reference[sample] * 0.5));
      }
      item.pcm = { referenceFrames: reference.length / 2, offsetFrames: offset / 2, maxError };
      assert(maxError < 0.000002, "Every independent reference PCM sample is present in order");
    }
    await context.close();
  }
  report.status = "passed";
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((accept) => server.close(accept));
  await writeFile(resolve(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`Ogg startup ${report.status}: ${root}`);
}
