import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { timedSpawnSync as spawnSync } from "./command-timing.mjs";
import { once } from "node:events";
import { chromium } from "./browser-timing.mjs";
import { createProject, buildProject } from "./sdk/project.mjs";
import { task, copySdlLibrary, copyWasmtimeLibrary, nativePlayer } from "./toolchain.mjs";
import { odinUnitTests } from "./odin-unit-tests.mjs";
import { serve } from "./serve.mjs";
import { resourceSchema as limits } from "../runtime/odin/web/constants.js";
import {
  configureResources,
  submitResources,
  loadSource,
  checkExecutor,
  deliverResources,
  readFrame,
} from "../runtime/odin/web/policy.js";

const synthesis = process.argv.includes("--synthesis");
const stress = process.argv.includes("--stress");
const expectedCompletions = synthesis ? (stress ? 0 : 4) : 4;
const root = resolve(
  synthesis ? "build/synthesis-verification" : "build/audio-verification",
  randomUUID(),
);
await mkdir(root, { recursive: true });
function run(exe, args, env = {}, diagnostics = false) {
  const result = spawnSync(exe, args, {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr || String(result.error));
  return result.stdout + (diagnostics ? result.stderr : "");
}
task("deps:trace:audio");
await copyFile("build/validation-tools/audio/trace.exe", resolve(root, "trace.exe"));
await copyWasmtimeLibrary(root);
await copySdlLibrary(root);
const report = {
  synthesis,
  stress,
  schedulingLeadFrames: limits.audioLeadFrames,
  rates: {},
  device: {},
  worklet: {},
};
let packetReference, pcmReference;
const projects = {};
await writeFile(
  resolve(root, "unit.log"),
  odinUnitTests("tests/audio", resolve(root, "mixer-tests.exe")),
);
for (const language of ["odin", "luau"]) {
  const project = resolve(root, language);
  await createProject(project, language);
  await copyFile(
    synthesis
      ? stress
        ? `tests/synthesis/stress/game.${language}`
        : `examples/resources/synthesis/${language}/main.${language}`
      : `tests/audio/cartridges/game.${language}`,
    resolve(project, `src/main.${language}`),
  );
  const manifest = JSON.parse(await readFile(resolve(project, "console.json")));
  manifest.display = [320, 180];
  await writeFile(resolve(project, "console.json"), JSON.stringify(manifest));
  await buildProject(project);
  projects[language] = project;
  const player = JSON.parse(
    run(resolve(project, "build/native", nativePlayer), ["--smoke"], {
      SDL_VIDEODRIVER: "dummy",
      SDL_AUDIODRIVER: "dummy",
      SDL_RENDER_DRIVER: "software",
    }),
  );
  assert.ok(player.audioMixerFrame > 0, "standalone native player invokes its PCM callback");
  report.device[`${language}Player`] = { audioMixerFrame: player.audioMixerFrame };
  const base = resolve(project, "build/web");
  const gameBytes = await readFile(
    resolve(base, language === "luau" ? "luau-executor.wasm" : "game.wasm"),
  );
  const source = language === "luau" ? await readFile(resolve(base, "game.luau")) : null;
  async function prepare() {
    const game = (
      await WebAssembly.instantiate(gameBytes, {
        env: {
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
      loadSource(game, source);
    }
    const runtime = (
      await WebAssembly.instantiate(await readFile(resolve(base, "runtime.wasm")), {
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
    runtime.runtime_init();
    configureResources(game, runtime);
    game.game_init();
    checkExecutor(game);
    submitResources(game, runtime);
    assert.equal(runtime.runtime_audio_enabled(), 1);
    const resourcePacket = Buffer.from(
      new Uint8Array(
        runtime.memory.buffer,
        runtime.runtime_resource_packet(),
        game.game_commit_size(),
      ),
    );
    return { game, runtime, resourcePacket };
  }
  const { runtime: exporting, resourcePacket } = await prepare();
  if (language === "odin" && synthesis && !stress) {
    const find = (opcode, occurrence = 0) => {
      let seen = 0;
      for (let i = 0; i < resourcePacket.readUInt32LE(32); i++) {
        const command = limits.headerBytes + i * limits.commandBytes;
        if (resourcePacket.readUInt16LE(command) === opcode && seen++ === occurrence) {
          const payload = resourcePacket.readUInt32LE(44);
          return {
            command,
            args: payload + resourcePacket.readUInt32LE(command + 12),
            data: payload + resourcePacket.readUInt32LE(command + 20),
          };
        }
      }
      throw new Error(`Missing synthesis opcode ${opcode}`);
    };
    const wave = find(limits.op_audio_wavetable);
    const graph = find(limits.op_audio_instrument).data;
    const node = (index) => graph + limits.graphHeaderBytes + index * limits.graphNodeBytes;
    const mutations = [
      ["wave size", (b) => b.writeUInt32LE(31, wave.args)],
      ["wave count", (b) => b.writeUInt32LE(limits.maxWaves + 1, wave.args + 4)],
      ["wave NaN", (b) => b.writeUInt32LE(0x7fc00000, wave.data)],
      ["wave amplitude", (b) => b.writeFloatLE(2, wave.data)],
      ["forward edge", (b) => b.writeUInt32LE(4, node(4) + 16)],
      ["audio/control port", (b) => b.writeUInt32LE(3, node(5) + 4)],
      ["wrong source kind", (b) => b.writeUInt32LE(limits.handleIndexMask - 1, node(0) + 12)],
      ["node kind", (b) => b.writeUInt32LE(1000, node(0))],
      ["graph count", (b) => b.writeUInt32LE(limits.maxInstrumentNodes + 1, graph)],
      ["graph history", (b) => b.writeUInt32LE(1, graph + 4)],
      ["filter stability", (b) => b.writeFloatLE(1, node(7) + 36)],
      ["delay capacity", (b) => b.writeUInt32LE(limits.maxDelayFrames + 1, node(8) + 28)],
      ["delay feedback", (b) => b.writeFloatLE(1, node(8) + 36)],
      ["note velocity", (b) => b.writeFloatLE(2, find(limits.op_audio_note_on).args + 20)],
      [
        "typed control",
        (b) => b.writeUInt32LE(limits.param_pan, find(limits.op_audio_node_control).args + 16),
      ],
      ["wave selection", (b) => b.writeFloatLE(2, find(limits.op_audio_node_control).args + 20)],
      ["edit bounds", (b) => b.writeUInt32LE(64, find(limits.op_audio_edit).args + 8)],
      ["reserved graph word", (b) => b.writeUInt32LE(1, graph + 8)],
      ["reserved node parameter", (b) => b.writeFloatLE(1, node(0) + 60)],
    ];
    const verifier = (
      await WebAssembly.instantiate(await readFile(resolve(base, "runtime.wasm")), {
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
    for (const [name, mutate] of mutations) {
      const session = verifier.runtime_resource_reset(limits.version);
      const valid = Buffer.from(resourcePacket);
      valid.writeUInt32LE(session, 12);
      const invalid = Buffer.from(valid);
      mutate(invalid);
      const pointer = verifier.runtime_resource_packet();
      new Uint8Array(verifier.memory.buffer, pointer, invalid.length).set(invalid);
      assert.equal(verifier.runtime_resource_submit(invalid.length), 0, `reject synthesis ${name}`);
      assert.equal(verifier.runtime_resource_bytes(), 0, `roll back synthesis ${name}`);
      assert.equal(verifier.runtime_audio_enabled(), 0, `roll back synthesis engine ${name}`);
      new Uint8Array(verifier.memory.buffer, pointer, valid.length).set(valid);
      assert.equal(
        verifier.runtime_resource_submit(valid.length),
        1,
        `recover after synthesis ${name}`,
      );
    }
    report.invalidSynthesisPackets = mutations.length;
  }
  if (language === "odin" && !synthesis) {
    const invalid = [];
    const locate = (opcode, occurrence = 0) => {
      let seen = 0;
      for (let i = 0; i < resourcePacket.readUInt32LE(32); i++) {
        const at = limits.headerBytes + i * limits.commandBytes;
        if (resourcePacket.readUInt16LE(at) === opcode && seen++ === occurrence) {
          const payload = resourcePacket.readUInt32LE(44);
          return {
            command: at,
            args: payload + resourcePacket.readUInt32LE(at + 12),
            data: payload + resourcePacket.readUInt32LE(at + 20),
          };
        }
      }
      throw new Error(`Missing audio fixture opcode ${opcode}`);
    };
    const play = locate(limits.op_audio_play_sample);
    const write = locate(limits.op_audio_stream_write);
    invalid.push(
      ["voice index", (b) => b.writeUInt32LE(limits.maxVoices, play.command + 8)],
      ["NaN rate", (b) => b.writeUInt32LE(0x7fc00000, play.args + 16)],
      ["sample generation", (b) => b.writeUInt32LE(0x20001, play.args + 8)],
      ["loop end", (b) => b.writeUInt32LE(100, play.data + 4)],
      ["event horizon", (b) => b.writeUInt32LE(limits.audioHorizonFrames + 1, play.args)],
      ["inexact frame", (b) => b.writeUInt32LE(2 ** 21, play.args + 4)],
      [
        "ramp horizon",
        (b) =>
          b.writeUInt32LE(
            limits.audioHorizonFrames + 1,
            locate(limits.op_audio_voice_control).args + 16,
          ),
      ],
      ["control type", (b) => b.writeUInt32LE(2, locate(limits.op_audio_voice_control).args + 8)],
      ["stream NaN", (b) => b.writeUInt32LE(0x7fc00000, write.data)],
      ["stream overlap", (b) => b.writeUInt32LE(520, locate(limits.op_audio_stream_write, 1).args)],
      ["reserved field", (b) => b.writeUInt32LE(1, locate(limits.op_audio_stream).args)],
    );
    const verifier = (
      await WebAssembly.instantiate(await readFile(resolve(base, "runtime.wasm")), {
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
    for (const [name, mutate] of invalid) {
      const session = verifier.runtime_resource_reset(3);
      const valid = Buffer.from(resourcePacket);
      valid.writeUInt32LE(session, 12);
      const bad = Buffer.from(valid);
      mutate(bad);
      const pointer = verifier.runtime_resource_packet();
      new Uint8Array(verifier.memory.buffer, pointer, bad.length).set(bad);
      assert.equal(verifier.runtime_resource_submit(bad.length), 0, `reject ${name}`);
      assert.equal(verifier.runtime_audio_enabled(), 0, `roll back ${name}`);
      assert.equal(verifier.runtime_resource_bytes(), 0, `resource rollback ${name}`);
      new Uint8Array(verifier.memory.buffer, pointer, valid.length).set(valid);
      assert.equal(verifier.runtime_resource_submit(valid.length), 1, `recover after ${name}`);
    }
    report.invalidResourcePackets = invalid.length;
  }
  const packets = [];
  for (;;) {
    const size = exporting.runtime_audio_export();
    if (!size) {
      break;
    }
    assert.ok(size > 0);
    packets.push(
      Buffer.from(new Uint8Array(exporting.memory.buffer, exporting.runtime_audio_packet(), size)),
    );
  }
  assert.ok(packets.length);
  if (language === "odin" && synthesis && !stress) {
    const packet = packets[0];
    const command = (op) => {
      for (let i = 0; i < packet.readUInt32LE(4); i++) {
        const at = limits.audioPacketHeaderBytes + i * limits.audioEventBytes;
        if (packet.readUInt32LE(at + 16) === op) {
          return at;
        }
      }
      throw new Error(`Missing prepared synthesis opcode ${op}`);
    };
    const graph = packet.readUInt32LE(command(limits.op_audio_instrument) + 84);
    const mutations = [
      ["source stride", (b) => b.writeUInt32LE(3, command(limits.op_audio_source) + 36)],
      [
        "source address",
        (b) => b.writeUInt32LE(limits.handleIndexMask, command(limits.op_audio_source) + 20),
      ],
      ["typed graph edge", (b) => b.writeUInt32LE(0, graph + limits.graphHeaderBytes + 4)],
      ["graph state size", (b) => b.writeUInt32LE(0, graph + 4)],
      ["note history size", (b) => b.writeUInt32LE(1, command(limits.op_audio_note_on) + 32)],
      [
        "edit offset",
        (b) => b.writeUInt32LE(limits.maxWaveFrames, command(limits.op_audio_edit) + 76),
      ],
      ["control slot", (b) => b.writeUInt32LE(8, command(limits.op_audio_node_control) + 76)],
      ["event order", (b) => b.writeUInt32LE(1000, command(limits.op_audio_note_on) + 8)],
    ];
    const dsp = (await WebAssembly.instantiate(await readFile(resolve(base, "audio.wasm")), {}))
      .instance.exports;
    for (const [name, mutate] of mutations) {
      assert.equal(dsp.audio_init(), 1);
      const invalid = Buffer.from(packet);
      mutate(invalid);
      const pointer = dsp.audio_packet();
      new Uint8Array(dsp.memory.buffer, pointer, invalid.length).set(invalid);
      assert.equal(dsp.audio_submit(invalid.length), 0, `reject prepared synthesis ${name}`);
      new Uint8Array(dsp.memory.buffer, pointer, packet.length).set(packet);
      assert.equal(dsp.audio_submit(packet.length), 1, `recover prepared synthesis ${name}`);
      assert.equal(dsp.audio_submit(packet.length), 0, "prepared synthesis replay rejected");
    }
    report.invalidPreparedSynthesisPackets = mutations.length;
  }
  if (language === "odin" && !synthesis) {
    const dsp = (await WebAssembly.instantiate(await readFile(resolve(base, "audio.wasm")), {}))
      .instance.exports;
    const packet = packets[0];
    const find = (opcode, occurrence = 0) => {
      let seen = 0;
      for (let i = 0; i < packet.readUInt32LE(4); i++) {
        const at = limits.audioPacketHeaderBytes + i * limits.audioEventBytes;
        if (packet.readUInt32LE(at + 16) === opcode && seen++ === occurrence) {
          return at;
        }
      }
      throw new Error("Missing prepared command");
    };
    const play = find(limits.op_audio_play_sample);
    const badPackets = [
      ["prepared voice", (b) => b.writeUInt32LE(limits.maxVoices, play + 20)],
      [
        "prepared bus parent",
        (b) => b.writeUInt32LE(limits.maxBuses, find(limits.op_audio_bus) + 48),
      ],
      [
        "prepared stream slot",
        (b) => b.writeUInt32LE(limits.maxStreams, find(limits.op_audio_stream) + 20),
      ],
      ["prepared source range", (b) => b.writeUInt32LE(limits.maxAudioSnapshotBytes, play + 28)],
      [
        "prepared duplicate lease",
        (b) =>
          b.writeUInt32LE(
            packet.readUInt32LE(play + 24),
            find(limits.op_audio_play_sample, 1) + 24,
          ),
      ],
      [
        "prepared duplicate pages",
        (b) =>
          b.writeUInt32LE(
            packet.readUInt32LE(play + 28),
            find(limits.op_audio_play_sample, 1) + 28,
          ),
      ],
      ["prepared NaN", (b) => b.writeUInt32LE(0x7fc00000, packet.readUInt32LE(play + 84))],
      ["prepared order", (b) => b.writeUInt32LE(99, play + 8)],
      ["prepared length", (b) => b.writeUInt32LE(packet.length + 1, 8)],
    ];
    for (const [name, mutate] of badPackets) {
      assert.equal(dsp.audio_init(), 1);
      const bad = Buffer.from(packet);
      mutate(bad);
      new Uint8Array(dsp.memory.buffer, dsp.audio_packet(), bad.length).set(bad);
      assert.equal(dsp.audio_submit(bad.length), 0, name);
      new Uint8Array(dsp.memory.buffer, dsp.audio_packet(), packet.length).set(packet);
      assert.equal(dsp.audio_submit(packet.length), 1, `atomic prepared rollback ${name}`);
      assert.equal(dsp.audio_submit(packet.length), 0, "prepared batches cannot be replayed");
    }
    report.invalidPreparedPackets = badPackets.length;
    // Full voice-bank workload: constant samples make clamping independently testable.
    const count = limits.maxVoices;
    const header = limits.audioPacketHeaderBytes + count * limits.audioEventBytes;
    const stress = Buffer.alloc(header + count * 4);
    stress.writeUInt32LE(packet.readUInt32LE(0), 0);
    stress.writeUInt32LE(count, 4);
    stress.writeUInt32LE(stress.length, 8);
    for (let i = 0; i < count; i++) {
      const at = limits.audioPacketHeaderBytes + i * limits.audioEventBytes;
      stress.writeUInt32LE(i, at + 8);
      stress.writeUInt32LE(limits.op_audio_play_sample, at + 16);
      stress.writeUInt32LE(i, at + 20);
      stress.writeUInt32LE(i + 1, at + 24);
      stress.writeUInt32LE(i, at + 28);
      stress.writeUInt32LE(1, at + 32);
      stress.writeUInt32LE(1, at + 36);
      stress.writeUInt32LE(limits.audioRate, at + 40);
      stress.writeUInt32LE(1, at + 60);
      stress.writeFloatLE(1, at + 64);
      stress.writeFloatLE(1, at + 68);
      stress.writeUInt32LE(header + i * 4, at + 84);
      stress.writeUInt32LE(4, at + 88);
      stress.writeFloatLE(0.5, header + i * 4);
    }
    report.fullVoiceBank = {};
    for (const rate of [44100, 48000, 96000]) {
      assert.equal(dsp.audio_init(), 1);
      new Uint8Array(dsp.memory.buffer, dsp.audio_packet(), stress.length).set(stress);
      assert.equal(dsp.audio_submit(stress.length), 1);
      const memoryBytes = dsp.memory.buffer.byteLength;
      const started = performance.now();
      for (let at = 0; at < 48000;) {
        const frames = Math.min(128, 48000 - at);
        const pointer = dsp.audio_render(frames, rate);
        const samples = new Float32Array(dsp.memory.buffer, pointer, frames * 2);
        const lead = (limits.audioLeadFrames * rate) / limits.audioRate;
        for (let i = 0; i < samples.length; i++) {
          assert.equal(
            samples[i],
            at + Math.floor(i / 2) < lead ? 0 : 1,
            "16 voices clamp at master",
          );
        }
        at += frames;
      }
      assert.equal(
        dsp.memory.buffer.byteLength,
        memoryBytes,
        "rendering does not grow Wasm memory",
      );
      report.fullVoiceBank[rate] = {
        renderAndCheckMs: performance.now() - started,
        memoryBytes,
      };
    }
  }
  if (packetReference) {
    assert.deepEqual(
      packets,
      packetReference,
      "SDKs produce identical prepared audio events and snapshots",
    );
  }
  packetReference = packets;
  await writeFile(resolve(base, "prepared-audio.bin"), packets[0]);
  for (const rate of [44100, 48000, 96000]) {
    const { game, runtime } = await prepare();
    const pcm = new Float32Array(48000 * 2);
    const memoryBefore = runtime.memory.buffer.byteLength;
    const renderStarted = performance.now();
    for (let at = 0; at < 48000;) {
      const frames = Math.min(128, 48000 - at);
      const pointer = runtime.runtime_audio_render(frames, rate);
      assert.ok(pointer);
      pcm.set(new Float32Array(runtime.memory.buffer, pointer, frames * 2), at * 2);
      at += frames;
    }
    const wasmRenderMs = performance.now() - renderStarted;
    assert.equal(
      runtime.memory.buffer.byteLength,
      memoryBefore,
      "DSP rendering does not grow linear memory",
    );
    deliverResources(game, runtime);
    game.game_update(0, 0, 0, 0);
    checkExecutor(game);
    game.game_draw();
    const sdkStatus = readFrame(game);
    assert.equal(
      sdkStatus.x,
      expectedCompletions,
      "SDK receives cumulative audio completion count",
    );
    assert.equal(sdkStatus.y, expectedCompletions, "SDK decodes completion records");
    const nativePath = resolve(root, `${language}-${rate}.f32`);
    const trace = run(resolve(root, "trace.exe"), [
      resolve(base, language === "luau" ? "luau-executor.wasm" : "game.wasm"),
      source ? resolve(base, "game.luau") : "",
      nativePath,
      String(rate),
      "offline",
      String(expectedCompletions),
    ]);
    const native = await readFile(nativePath);
    let error = 0;
    for (let i = 0; i < pcm.length; i++) {
      error = Math.max(error, Math.abs(native.readFloatLE(i * 4) - pcm[i]));
    }
    assert.ok(error <= 1e-6, `native/browser ${language} ${rate} maximum error ${error}`);
    const status = JSON.parse(trace.trim().split("\n").at(-1));
    assert.equal(status.late, 0);
    assert.equal(status.underruns, synthesis ? 0 : 80);
    report.rates[`${language}-${rate}`] = {
      maximumError: error,
      ...status,
      wasmRenderMs,
      runtimeMemoryBytes: memoryBefore,
    };
    if (rate === 48000) {
      if (pcmReference) {
        assert.deepEqual(pcm, pcmReference, "SDKs render the same PCM");
      }
      pcmReference = pcm;
      // Analytic checks use a separate implementation, not another instance of the mixer.
      const wave = [0, 8192, 16384, 24576, 32767, 24576, 16384, 8192].map((n) => n / 32768);
      const sample = (position, loopStart = null) => {
        const first = Math.floor(position),
          fraction = position - first;
        const second = first + 1 >= 8 ? (loopStart ?? 7) : first + 1;
        return wave[first] + (wave[second] - wave[first]) * fraction;
      };
      for (let n = 0; !synthesis && n < 1000; n++) {
        const position = n * 0.5;
        let left = sample(position % 8, 0) * Math.fround(0.02),
          right = left;
        if (n < 320) {
          const p = position < 8 ? position : 2 + ((position - 2) % 6);
          const gain =
            n < 64 ? 0.5 : n < 96 ? 0.5 + (n - 64) / 64 : n < 300 ? 1 : 1 - (n - 300) / 20;
          const pan = n < 128 ? -0.25 : n < 160 ? -0.25 + ((n - 128) * 0.75) / 32 : 0.5;
          const bus = n < 192 ? 0.5 : n < 208 ? 0.5 - (n - 192) / 64 : 0.25;
          const value = sample(p, 2) * gain * bus;
          left += value * Math.min(1, 1 - pan);
          right += value * Math.min(1, 1 + pan);
        }
        if (n >= 24 && n < 40) {
          const value = sample((n - 24) * 0.5) * 0.25;
          left += value * 0.5;
          right += value;
        }
        if ((n >= 512 && n < 640) || (n >= 800 && n < 864)) {
          left += Math.fround(0.2) * 0.5;
          right -= Math.fround(0.2) * 0.5;
        }
        const at = (limits.audioLeadFrames + n) * 2;
        assert.ok(
          Math.abs(pcm[at] - left) <= 1e-6 && Math.abs(pcm[at + 1] - right) <= 1e-6,
          `independent PCM reference at ${n}: ${pcm[at]},${pcm[at + 1]} vs ${left},${right}`,
        );
      }
      assert.ok(
        pcm.slice(0, limits.audioLeadFrames * 2).every((value) => value === 0),
        "reported scheduling lead is silence",
      );
      const devicePath = resolve(root, `${language}-device.f32`);
      const deviceTrace = run(
        resolve(root, "trace.exe"),
        [
          resolve(base, language === "luau" ? "luau-executor.wasm" : "game.wasm"),
          source ? resolve(base, "game.luau") : "",
          devicePath,
          "48000",
          "device",
          String(expectedCompletions),
        ],
        { SDL_AUDIODRIVER: "dummy" },
      );
      const captured = await readFile(devicePath);
      for (let i = 0; i < pcm.length; i++) {
        assert.ok(
          Math.abs(captured.readFloatLE(i * 4) - pcm[i]) <= 1e-6,
          `SDL callback output at ${i}`,
        );
      }
      report.device[language] = JSON.parse(deviceTrace.trim().split("\n")[0]);
    }
  }
}

await copyFile("tests/audio/web/capture-worklet.js", resolve(root, "capture-worklet.js"));
await copyFile("tests/audio/web/stall-worker.js", resolve(root, "stall-worker.js"));
await writeFile(resolve(root, "harness.html"), "<!doctype html><title>Audio verification</title>");
const server = serve(root, 0);
await once(server, "listening");
const browser = await chromium.launch({
  headless: true,
  channel: process.env.PLAYER_BROWSER_CHANNEL || undefined,
  args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
});
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/harness.html`);
  for (const language of ["odin", "luau"]) {
    const result = await page.evaluate(
      async ({ language }) => {
        const base = `./${language}/build/web/`;
        await (await fetch(`${base}audio.wasm`)).arrayBuffer();
        const context = new AudioContext({ sampleRate: 48000 });
        // A running mixer can advance before the capture node is constructed.
        await context.suspend();
        await context.audioWorklet.addModule(`${base}audio-worklet.js`);
        await context.audioWorklet.addModule("./capture-worklet.js");
        const module = await WebAssembly.compile(
          await (await fetch(`${base}audio.wasm`)).arrayBuffer(),
        );
        const mixer = new AudioWorkletNode(context, "console-pcm-mixer", {
          numberOfInputs: 0,
          outputChannelCount: [2],
          processorOptions: { module },
        });
        // Exercise setup latency: DSP time must stay at zero until capture is connected.
        await new Promise((resolve) => setTimeout(resolve, 50));
        const capture = new AudioWorkletNode(context, "capture", {
          numberOfInputs: 1,
          outputChannelCount: [2],
        });
        let feedbackFrames = 0,
          epoch = 0,
          error = "";
        mixer.port.onmessage = ({ data }) => {
          if (data.type === "error") {
            error = data.error;
          }
          if (data.type === "feedback") {
            const view = new DataView(data.buffer);
            feedbackFrames = view.getUint32(16, true);
            epoch = view.getUint32(12, true);
            mixer.port.postMessage({ type: "feedback-recycle", id: data.id, buffer: data.buffer }, [
              data.buffer,
            ]);
          }
        };
        const packet = await (await fetch(`${base}prepared-audio.bin`)).arrayBuffer();
        mixer.port.postMessage(
          { type: "packet", id: 0, buffer: packet, bytes: packet.byteLength },
          [packet],
        );
        const recording = new Promise((resolve, reject) => {
          capture.port.onmessage = ({ data }) => resolve(data.pcm);
          setTimeout(() => reject(new Error(error || "AudioWorklet capture timeout")), 10000);
        });
        mixer.connect(capture);
        capture.connect(context.destination);
        await context.resume();
        await new Promise((resolve) => setTimeout(resolve, 150));
        const stalledWorker = new Worker("./stall-worker.js");
        const workerFinished = new Promise((resolve) => {
          stalledWorker.onmessage = resolve;
        });
        stalledWorker.postMessage("stall");
        const before = feedbackFrames;
        const started = performance.now();
        while (performance.now() - started < 500) {
          /* Deliberate main-thread stall; DSP runs independently. */
        }
        const pcm = await recording;
        await workerFinished;
        stalledWorker.terminate();
        await new Promise((resolve) => setTimeout(resolve, 80));
        const after = feedbackFrames;
        mixer.port.postMessage({ type: "pause", paused: true });
        await new Promise((resolve) => setTimeout(resolve, 120));
        const paused = feedbackFrames;
        await new Promise((resolve) => setTimeout(resolve, 100));
        const stillPaused = feedbackFrames;
        mixer.port.postMessage({ type: "pause", paused: false });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const resumed = feedbackFrames;
        mixer.disconnect();
        capture.disconnect();
        await context.close();
        return {
          pcm: Array.from(new Float32Array(pcm)),
          before,
          after,
          paused,
          stillPaused,
          resumed,
          epoch,
          error,
          isolated: crossOriginIsolated,
        };
      },
      { language },
    );
    assert.equal(result.error, "");
    assert.equal(result.isolated, false);
    assert.ok(result.after - result.before > 20000, "worklet survives main-thread stall");
    assert.equal(result.paused, result.stillPaused, "pause freezes logical DSP time after fade");
    assert.ok(
      result.resumed > result.stillPaused && result.epoch >= 3,
      "resume advances same session under a new audio epoch",
    );
    let maximumError = 0;
    for (let i = 0; i < pcmReference.length; i++) {
      maximumError = Math.max(maximumError, Math.abs(pcmReference[i] - result.pcm[i]));
    }
    if (maximumError > 1e-6) {
      await writeFile(
        resolve(root, `worklet-${language}-actual.f32`),
        Buffer.from(new Float32Array(result.pcm).buffer),
      );
      await writeFile(
        resolve(root, `worklet-${language}-expected.f32`),
        Buffer.from(new Float32Array(pcmReference).buffer),
      );
    }
    assert.ok(maximumError <= 1e-6, `${language} worklet PCM error ${maximumError}; ${root}`);
    const { pcm: _pcm, ...measurement } = result;
    report.worklet[language] = { ...measurement, maximumError };
  }
  report.player = {};
  for (const language of ["odin", "luau"]) {
    const startupProject = resolve(root, `startup-${language}`);
    await createProject(startupProject, language);
    await copyFile(
      `tests/audio/startup/game.${language}`,
      resolve(startupProject, `src/main.${language}`),
    );
    await buildProject(startupProject);
    let releaseMixer;
    let mixerRequested = false;
    const mixerGate = new Promise((resolve) => {
      releaseMixer = resolve;
    });
    const delayMixer = async (route) => {
      mixerRequested = true;
      await mixerGate;
      await route.continue();
    };
    await page.route("**/audio.wasm", delayMixer);
    await page.goto(
      `http://127.0.0.1:${server.address().port}/startup-${language}/build/web/player.html`,
    );
    await page.waitForFunction(() => playerStatus.ready || playerStatus.error);
    assert.equal(await page.evaluate(() => playerStatus.error), "");
    const beforeStart = await page.evaluate(() => playerStatus.ticks);
    let delayedStartup;
    try {
      await page.click("#start");
      await page.waitForTimeout(1000);
      assert.ok(mixerRequested, "startup waits on the actual mixer download");
      delayedStartup = await page.evaluate(() => ({
        ticks: playerStatus.ticks,
        error: playerStatus.error,
      }));
      assert.equal(delayedStartup.error, "", "delayed mixer does not exhaust audio queue credits");
      assert.equal(delayedStartup.ticks, beforeStart, "simulation waits for mixer readiness");
      if (language === "luau") {
        await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      }
    } finally {
      releaseMixer();
    }
    await page.waitForFunction(() => playerAudio.mixerStatus?.frame > 5000);
    await page.unroute("**/audio.wasm", delayMixer);
    if (language === "luau") {
      assert.equal(
        await page.evaluate(() => playerStatus.ticks),
        beforeStart,
        "blur cancels a pending start instead of resuming after mixer loading",
      );
      await page.click("#start");
    }
    assert.equal(await page.evaluate(() => playerStatus.error), "");
    await page.waitForFunction(() => playerStatus.ticks >= 60 || playerStatus.error);
    assert.equal(
      await page.evaluate(() => playerStatus.error),
      "",
      "audio scheduling continues after startup",
    );
    await page.goto(`http://127.0.0.1:${server.address().port}/${language}/build/web/player.html`);
    await page.waitForFunction(() => playerStatus.ready || playerStatus.error);
    assert.equal(await page.evaluate(() => playerStatus.error), "");
    await page.click("#start");
    await page.waitForFunction(() => playerAudio.mixerStatus?.frame > 5000);
    const initial = await page.evaluate(() => playerAudio.mixerStatus);
    if (synthesis && !stress) {
      const hash = await page.evaluate(() => playerStatus.hash);
      await page.keyboard.down("ArrowRight");
      await page.waitForFunction((previous) => playerStatus.hash !== previous, hash);
      await page.keyboard.up("ArrowRight");
      assert.equal(
        await page.evaluate(() => playerStatus.error),
        "",
        "tone editor input updates its graph controls",
      );
    }
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.waitForTimeout(150);
    const paused = await page.evaluate(() => playerAudio.mixerStatus.frame);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => playerAudio.mixerStatus.frame), paused);
    await page.click("#start");
    await page.waitForFunction((frame) => playerAudio.mixerStatus?.frame > frame, paused);
    const resumed = await page.evaluate(() => playerAudio.mixerStatus);
    assert.ok(resumed.epoch > initial.epoch);
    await page.setInputFiles("#cartridge", resolve(projects[language], "build/game.png"));
    await page.waitForFunction(() => playerStatus.ready && !playerAudio.mixerStatus);
    await page.click("#start");
    await page.waitForFunction(() => playerAudio.mixerStatus?.frame > 5000);
    const reloaded = await page.evaluate(() => ({
      ...playerAudio.mixerStatus,
      error: playerStatus.error,
    }));
    assert.equal(reloaded.error, "");
    assert.equal(reloaded.epoch, initial.epoch, "reload creates a fresh audio epoch");
    report.player[language] = { delayedStartup, initial, pausedFrame: paused, resumed, reloaded };
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
await writeFile(resolve(root, "results.json"), JSON.stringify(report, null, 2) + "\n");
console.log(
  `${synthesis ? "Synthesis" : "Audio"}${stress ? " stress" : ""} passed: both SDKs, native/Wasm PCM at three rates, SDL callbacks, Worklet stalls, pause/resume, reload and no shared memory. ${relative(process.cwd(), root)}`,
);
