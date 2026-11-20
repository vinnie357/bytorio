import { nativePlayer } from "./toolchain.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { chromium } from "./browser-timing.mjs";
import { buildResourceExamples } from "../examples/resources/tools/build.mjs";
import { manifest, requireNativePlayer } from "./sdk/project.mjs";
import { chunks, chunk } from "./sdk/cartridge.mjs";
import { negotiateProfile } from "../runtime/odin/web/policy.js";
import { resourceSchema, RESOURCE_EXPORTS } from "../runtime/odin/web/constants.js";
import { serve } from "./serve.mjs";
requireNativePlayer();

const root = resolve("build/profile-verification", randomUUID());
await mkdir(root, { recursive: true });
const profile = JSON.parse(await readFile("sdk/profiles/resource-av-1.json"));
const contract = JSON.parse(await readFile("sdk/contract.json"));
assert.equal(profile.status, "published");
assert.equal(profile.profile, contract.profile);
assert.equal(profile.sdkVersion, contract.sdkVersion);
assert.equal(profile.abiVersion, contract.abiVersion);
assert.equal(profile.protocolVersion, resourceSchema.stableVersion);
const advertised = contract.profiles.find((item) => item.id === profile.profileId);
assert.deepEqual(
  [profile.sdkVersionWord, profile.abiVersion, profile.protocolVersion, profile.requiredFeatures],
  [advertised.sdkWord, advertised.abi, advertised.protocol, advertised.features],
);
assert.equal(profile.targets.guestMemoryBytes, contract.limits.guestMemoryBytes);
assert.equal(profile.targets.luauMemoryBytes, contract.limits.luauMemoryBytes);
assert.equal(profile.targets.luauHeapBytes, contract.limits.luauHeapBytes);
for (const [target, constant] of Object.entries({
  resourceSlots: "maxSlots",
  runtimeResourceBytes: "maxResourceBytes",
  commandsPerCommit: "maxCommands",
  payloadBytesPerCommit: "maxPayload",
  audioRate: "audioRate",
  voices: "maxVoices",
  busesIncludingMaster: "maxBuses",
  activeDspNodes: "maxActiveNodes",
  initialSchedulingLeadFrames: "audioLeadFrames",
  maxImageWidth: "maxImageAxis",
  maxImageHeight: "maxImageAxis",
  offscreenTargets: "maxTargets",
  outstandingReadbacks: "maxReadbacks",
  readbackBytes: "maxReadbackBytes",
  completionPayloadBytesPerUpdate: "maxCompletionPayload",
  paletteEntries: "paletteEntries",
  colorTableEntries: "colorTableBytes",
  instrumentDefinitions: "maxInstruments",
  nodesPerInstrument: "maxInstrumentNodes",
  nodesPerBus: "maxBusNodes",
  maxDelayFrames: "maxDelayFrames",
})) {
  assert.equal(profile.targets[target], resourceSchema[constant], target);
}
const valid = {
  ...Object.fromEntries(RESOURCE_EXPORTS.map(({ name }) => [name, () => 0])),
  game_profile: () => 2,
  game_abi: () => 2,
  game_sdk_version: () => 512,
  game_frame_size: () => 40,
  game_required_features: () => 7,
  game_resource_protocol: () => 4,
};
assert.equal(negotiateProfile(valid), 2);
for (const [name, value] of Object.entries({
  game_profile: 3,
  game_abi: 1,
  game_sdk_version: 256,
  game_frame_size: 0,
  game_required_features: 15,
  game_resource_protocol: 5,
})) {
  assert.throws(() => negotiateProfile({ ...valid, [name]: () => value }), /Unsupported/, name);
}
assert.throws(() => negotiateProfile(valid, { profile: 1, abi: 1, sdk: 256 }), /metadata/);

const projects = await buildResourceExamples(root);
const env = {
  ...process.env,
  SDL_VIDEODRIVER: "dummy",
  SDL_AUDIODRIVER: "dummy",
  SDL_RENDER_DRIVER: "software",
};
function native(project, args, status = 0) {
  const result = spawnSync(resolve(project, "build/native", nativePlayer), args, {
    env,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, status, result.stderr + result.stdout);
  return result;
}
function changeMetadata(png, edit) {
  const part = chunks(png).find((item) => item.type === "caRt");
  const data = Buffer.from(part.data);
  edit(data);
  return Buffer.concat([png.subarray(0, part.offset), chunk("caRt", data), png.subarray(part.end)]);
}
// Redirect a query to another real i32 query without changing its Wasm type.
// This exercises each player's negotiation with an executable malformed guest.
function redirectQuery(input, name, replacement) {
  const data = Buffer.from(input);
  let cursor = 8;
  const leb = () => {
    let result = 0,
      shift = 0,
      byte;
    do {
      byte = data[cursor++];
      result += (byte & 127) * 2 ** shift;
      shift += 7;
    } while (byte & 128);
    return result;
  };
  const encode = (value) => {
    const bytes = [];
    do {
      const byte = value & 127;
      value >>>= 7;
      bytes.push(byte | (value ? 128 : 0));
    } while (value);
    return Buffer.from(bytes);
  };
  while (cursor < data.length) {
    const sectionStart = cursor,
      kind = data[cursor++],
      size = leb(),
      start = cursor,
      end = start + size;
    if (kind === 7) {
      const entries = new Map();
      const count = leb();
      for (let i = 0; i < count; i++) {
        const size = leb(),
          key = data.toString("utf8", cursor, cursor + size);
        cursor += size;
        const type = data[cursor++],
          first = cursor,
          index = leb();
        entries.set(key, { type, first, last: cursor, index });
      }
      const target = entries.get(name),
        source = entries.get(replacement);
      assert.equal(target.type, 0);
      assert.equal(source.type, 0);
      const body = Buffer.concat([
        data.subarray(start, target.first),
        encode(source.index),
        data.subarray(target.last, end),
      ]);
      return Buffer.concat([
        data.subarray(0, sectionStart),
        Buffer.from([7]),
        encode(body.length),
        body,
        data.subarray(end),
      ]);
    }
    cursor = end;
  }
  throw new Error("Missing Wasm export section");
}
const results = [];
const server = serve(root, 0);
await once(server, "listening");
const browser = await chromium.launch({
  channel: process.env.PLAYER_BROWSER_CHANNEL || "chrome",
  headless: true,
});
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const { project, demo, language } of projects) {
    if (demo === "graphics" && language === "odin") {
      const path = resolve(project, "console.json");
      const original = await readFile(path, "utf8");
      const spec = JSON.parse(original);
      try {
        for (const profile of [0, null, "", "unknown", "2d-preview-1"]) {
          await writeFile(path, JSON.stringify({ ...spec, profile }));
          await assert.rejects(() => manifest(project), /Unsupported SDK or profile/);
        }
        const legacy = { ...spec, sdk: "0.1.0" };
        delete legacy.profile;
        await writeFile(path, JSON.stringify(legacy));
        assert.equal(
          (await manifest(project)).profileId,
          1,
          "existing manifests retain the legacy profile",
        );
      } finally {
        await writeFile(path, original);
      }
    }
    let page = await browser.newPage();
    const web = `${base}/${relative(root, project).replaceAll("\\", "/")}/build/web`;
    const loose =
      language === "luau"
        ? [
            "--game",
            resolve(project, "build/native/luau-executor.wasm"),
            "--source",
            resolve(project, "build/native/game.luau"),
          ]
        : ["--game", resolve(project, "build/native/game.wasm")];
    const png = await readFile(resolve(project, "build/game.png"));
    if (demo === "graphics") {
      const code = await readFile(
        resolve(
          project,
          `build/native/${language === "luau" ? "luau-executor.wasm" : "game.wasm"}`,
        ),
      );
      const source =
        language === "luau" ? await readFile(resolve(project, "build/native/game.luau")) : null;
      await page.goto(`${web}/debug.html?smoke`);
      await page.waitForFunction(() => playerStatus.ready || playerStatus.error);
      for (const query of [
        "game_required_features",
        "game_resource_protocol",
        "game_sdk_version",
        "game_frame_size",
        "game_update",
      ]) {
        const malformed = redirectQuery(code, query, "game_profile");
        const badPath = resolve(project, `${query}.wasm`);
        await writeFile(badPath, malformed);
        const flags = ["--game", badPath, "--check"];
        if (source) {
          flags.push("--source", resolve(project, "build/native/game.luau"));
        }
        assert.match(native(project, flags, 1).stderr, /profile|ABI|SDK/);
        const error = await page.evaluate(
          async ({ code, source }) => {
            const policy = await import("./policy.js");
            try {
              const module = policy.inspectGuest(new Uint8Array(code), undefined, {
                luauExecutor: !!source,
              });
              const game = (
                await WebAssembly.instantiate(module, {
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
              ).exports;
              game._initialize?.();
              if (source) {
                policy.loadSource(game, new Uint8Array(source));
              }
              policy.negotiateProfile(game);
              return "";
            } catch (error) {
              return error.message;
            }
          },
          { code: [...malformed], source: source ? [...source] : null },
        );
        assert.match(error, /Unsupported|signature/);
      }
      if (source) {
        const unsupported = Buffer.from(
          source.toString("utf8").replace("--!console-profile=2", "--!console-profile=9"),
        );
        const sourcePath = resolve(project, "unsupported.luau");
        await writeFile(sourcePath, unsupported);
        assert.match(
          native(
            project,
            [
              "--game",
              resolve(project, "build/native/luau-executor.wasm"),
              "--source",
              sourcePath,
              "--check",
            ],
            1,
          ).stderr,
          /profile/,
        );
        const error = await page.evaluate(
          async ({ code, source }) => {
            const policy = await import("./policy.js");
            const game = (
              await WebAssembly.instantiate(new Uint8Array(code), {
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
            policy.loadSource(game, new Uint8Array(source));
            try {
              policy.negotiateProfile(game);
              return "";
            } catch (error) {
              return error.message;
            }
          },
          { code: [...code], source: [...unsupported] },
        );
        assert.match(error, /Unsupported/);
      }
      // Each timing series begins in a fresh page/cache.
      await page.close();
      page = await browser.newPage();
    }
    const nativePng = JSON.parse(native(project, ["--smoke"]).stdout);
    const nativeLoose = JSON.parse(native(project, [...loose, "--smoke"]).stdout);
    assert.equal(nativePng.hash, nativeLoose.hash);
    if (demo === "synthesis") {
      const unavailable = spawnSync(resolve(project, "build/native", nativePlayer), ["--smoke"], {
        env: { ...env, SDL_AUDIODRIVER: "unavailable-profile-test" },
        encoding: "utf8",
        timeout: 30000,
      });
      assert.ifError(unavailable.error);
      assert.equal(unavailable.status, 1);
      assert.match(unavailable.stderr, /audio|driver/i);
      const devicePage = await browser.newPage();
      await devicePage.addInitScript(() => {
        window.AudioContext = class {
          constructor() {
            throw new Error("Test audio device allocation failure");
          }
        };
      });
      await devicePage.goto(`${web}/debug.html?game=./game.png&smoke`);
      await devicePage.waitForFunction(() => playerStatus.ready || playerStatus.error);
      assert.equal(await devicePage.evaluate(() => playerStatus.error), "");
      await devicePage.locator("#start").click();
      await devicePage.waitForFunction(() => !!playerStatus.error);
      assert.match(
        await devicePage.evaluate(() => playerStatus.error),
        /device allocation failure/,
      );
      assert.equal(await devicePage.evaluate(() => playerStatus.ready), false);
      await devicePage.close();
    }
    for (const host of ["native", "web"]) {
      const packaged = JSON.parse(await readFile(resolve(project, `build/${host}/profile.json`)));
      assert.equal(packaged.id, 2);
      assert.equal(packaged.features, 7);
      const descriptor = JSON.parse(
        await readFile(resolve(project, `build/${host}/resource-av-1.json`)),
      );
      assert.equal(descriptor.packet.schema, packaged.schema);
      assert.equal(descriptor.requiredFeatures, packaged.features);
      assert.deepEqual(descriptor.targets, profile.targets);
      assert.deepEqual(
        JSON.parse(await readFile(resolve(project, `build/${host}/resource-protocol.json`))),
        JSON.parse(await readFile("sdk/resource-protocol.json")),
      );
    }
    const inputs = resolve(project, "benchmark.inputs");
    await writeFile(inputs, Array(30).fill("0").join("\n") + "\n");
    const nativeBenchmarks = [];
    for (const flags of [["--no-executor-cache"], []]) {
      const measured = JSON.parse(native(project, ["--benchmark", inputs, ...flags]).stdout);
      nativeBenchmarks.push({
        startup: measured.startup,
        memory: measured.memory,
        executorCacheEnabled: measured.executorCacheEnabled,
        timings: measured.timings,
      });
    }
    const record = {
      demo,
      language,
      nativeHash: nativePng.hash,
      nativeBenchmarks,
      loads: [],
    };
    for (const [index, game] of [
      "game.png",
      language === "luau" ? "game.luau" : "game.wasm",
      "game.png",
    ].entries()) {
      if (index === 2) {
        await page.evaluate(() => {
          playerStatus.ready = false;
          playerStatus.error = "";
        });
        await page
          .locator("#cartridge")
          .setInputFiles({ name: "warm.png", mimeType: "image/png", buffer: png });
      } else {
        await page.goto(`${web}/debug.html?game=./${game}&smoke`);
      }
      await page.waitForFunction(() => playerStatus.ready || playerStatus.error);
      assert.equal(await page.evaluate(() => playerStatus.error), "");
      const startup = await page.evaluate(() => ({
        startup: playerStatus.startup,
        memory: playerStatus.memory,
      }));
      record.loads.push({ game, ...startup });
      assert.ok(startup.memory.currentLinear > 0);
      if (language === "luau") {
        assert.equal(
          startup.startup.executorCache.hit,
          index === 2,
          "warm replacement reuses the compiled executor",
        );
      }
      await page.locator("#start").click();
      await page.waitForFunction(() => playerStatus.ticks >= 120 || playerStatus.error);
      assert.equal(await page.evaluate(() => playerStatus.error), "");
      assert.equal(
        await page.evaluate(() => playerStatus.hash),
        nativePng.hash,
        `${demo}/${language}/${game}`,
      );
    }
    const mismatch = changeMetadata(png, (data) => {
      data[7] = 1;
      data.writeUInt32LE(256, 8);
      data.writeUInt32LE(1, 12);
    });
    const file = resolve(project, "mismatch.png");
    await writeFile(file, mismatch);
    assert.match(native(project, ["--game", file, "--check"], 1).stderr, /profile|SDK|ABI/);
    await page.evaluate(() => {
      playerStatus.ready = false;
      playerStatus.error = "";
    });
    await page
      .locator("#cartridge")
      .setInputFiles({ name: "mismatch.png", mimeType: "image/png", buffer: mismatch });
    await page.waitForFunction(() => !!playerStatus.error);
    assert.match(await page.evaluate(() => playerStatus.error), /metadata/);
    // Recovery starts a new session, even after a failed cartridge load.
    await page.evaluate(() => {
      playerStatus.ready = false;
      playerStatus.error = "";
    });
    await page
      .locator("#cartridge")
      .setInputFiles({ name: "valid.png", mimeType: "image/png", buffer: png });
    await page.waitForFunction(() => playerStatus.ready || playerStatus.error);
    assert.equal(await page.evaluate(() => playerStatus.error), "");
    await page.locator("#canvas").dispatchEvent("contextlost");
    assert.match(await page.evaluate(() => playerStatus.error), /context lost/);
    assert.equal(await page.evaluate(() => playerStatus.ready), false);
    await page.locator("#start").click();
    await page.waitForFunction(() => playerStatus.ready || playerStatus.error);
    assert.equal(await page.evaluate(() => playerStatus.error), "");
    await page.close();
    results.push(record);
  }
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
await writeFile(
  resolve(root, "results.json"),
  JSON.stringify({ profile: profile.profile, results }, null, 2) + "\n",
);
console.log(
  `Resource profile verified: both SDKs, PNG/loose payloads, native/browser, reload and context-loss recovery. Results: ${relative(process.cwd(), root)}`,
);
