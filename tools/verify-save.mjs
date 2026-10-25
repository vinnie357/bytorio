import { nativePlayer, windowsHost } from "./toolchain.mjs";
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile, readdir, chmod, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { timedSpawnSync as spawnSync } from "./command-timing.mjs";
import { createProject, buildProject, requireNativePlayer } from "./sdk/project.mjs";
import { chromium } from "./browser-timing.mjs";
import { chunks, chunk, encodeSaveIdentity, encodeContent } from "./sdk/cartridge.mjs";
import { decodeCartridge } from "../runtime/odin/web/cartridge.js";
import { serve } from "./serve.mjs";
requireNativePlayer();

const root = resolve("build/save-verification", randomUUID());
await mkdir(root, { recursive: true });
const expected = Buffer.from(Array.from({ length: 65536 }, (_, i) => (i * 37 + 11) % 256));
const projects = {};
const savedKeys = [];
for (const language of ["odin", "luau"]) {
  const project = resolve(root, language);
  projects[language] = project;
  await createProject(project, language);
  await copyFile(`tests/save/game.${language}`, resolve(project, `src/main.${language}`));
  await buildProject(project);
  const cartridge = resolve(project, "build/game.png");
  const saveDirectory = resolve(root, "saves");
  const key = createHash("sha256")
    .update(await readFile(cartridge))
    .digest("hex");
  const saved = resolve(saveDirectory, `${key}.sav`);
  savedKeys.push(`${key}.sav`);
  const replay = resolve(project, "inputs.txt");
  async function native(masks, expectedExit = 0, input = cartridge) {
    await writeFile(replay, masks.join("\n"));
    const result = spawnSync(
      resolve(project, "build/native", nativePlayer),
      [input, "--replay", replay],
      {
        encoding: "utf8",
        timeout: 30000,
        env: { ...process.env, BYTORIO_SAVE_DIRECTORY: saveDirectory },
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, expectedExit, result.stderr + result.stdout);
    return result.status === 0 ? result.stdout.trim().split(/\r?\n/).map(JSON.parse) : [];
  }
  const first = await native([16, 0, 2, 0, 1]);
  assert.deepEqual(
    first.map((frame) => frame.sounds),
    [0, 0, 1, 1, 2],
  );
  assert.deepEqual(
    await readFile(saved),
    expected,
    "maximum-size write owns original staging bytes",
  );
  // Windows refuses to replace a read-only file. POSIX rename ignores the target file mode and
  // checks the directory instead, so the same failure needs a read-only save directory there.
  const [locked, readOnly, writable] = windowsHost
    ? [saved, 0o444, 0o666]
    : [saveDirectory, 0o555, 0o755];
  await chmod(locked, readOnly);
  try {
    await native([4], 1);
    assert.deepEqual(await readFile(saved), expected, "failed atomic replace retains prior save");
  } finally {
    await chmod(locked, writable);
  }
  await native([8, 0, 2]);
  assert.deepEqual(await readFile(saved), expected.subarray(0, 4096));
  assert.equal((await native([0]))[0].sounds, 1, "legacy-size record remains readable");
  const replaced = await native([4, 0, 2]);
  assert.deepEqual(
    replaced.map((frame) => frame.sounds),
    [1, 1, 2],
  );
  assert.deepEqual(await readFile(saved), Buffer.from([7, 8, 9]));
  assert.equal((await native([0]))[0].sounds, 1, "fresh process reads stored bytes");
  assert.deepEqual(
    (await readdir(saveDirectory)).sort(),
    [...savedKeys].sort(),
    "temporary file cleaned after success and failure",
  );
  await writeFile(saved, Buffer.alloc(65537));
  assert.equal((await native([0]))[0].sounds, 0, "oversized disk record rejected before reading");
  const original = await readFile(cartridge);
  const manifestPath = resolve(project, "console.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.save = { id: "org.example.save-" + language, legacy: ["0".repeat(64), key] };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await buildProject(project);
  const stable = await readFile(cartridge);
  assert.equal(chunks(stable).filter(({ type }) => type === "saVe").length, 1);
  const runtime = (
    await WebAssembly.instantiate(await readFile(resolve(project, "build/web/runtime.wasm")), {
      env: { sin: Math.sin },
    })
  ).instance.exports;
  assert.equal(decodeCartridge(runtime, stable).saveId, manifest.save.id);
  const metadata = chunks(stable).find(({ type }) => type === "saVe").data;
  const invalidMetadata = [
    Buffer.from([2, 1, 0, 0, 97]),
    Buffer.from([1, 1, 0, 1, 97]),
    Buffer.from([1, 0, 0, 0]),
    Buffer.from([1, 1, 17, 0, 97]),
    Buffer.from([1, 1, 0, 0, 47]),
    Buffer.from([1, 2, 0, 0, 97]),
    Buffer.from([1, 1, 0, 0, 97, 0]),
    Buffer.concat([Buffer.from([1, 1, 2, 0, 97]), Buffer.alloc(64)]),
  ];
  for (const [index, data] of invalidMetadata.entries()) {
    const malformed = Buffer.concat(
      chunks(stable).reduce(
        (parts, part) => [
          ...parts,
          part.type === "saVe" ? chunk("saVe", data) : stable.subarray(part.offset, part.end),
        ],
        [stable.subarray(0, 8)],
      ),
    );
    assert.throws(() => decodeCartridge(runtime, malformed), /save/);
    const path = resolve(project, "invalid-" + index + ".png");
    await writeFile(path, malformed);
    await native([0], 1, path);
  }
  const duplicate = Buffer.concat([
    stable.subarray(0, -12),
    chunk("saVe", metadata),
    stable.subarray(-12),
  ]);
  assert.throws(() => decodeCartridge(runtime, duplicate), /duplicate/);
  const duplicatePath = resolve(project, "duplicate.png");
  await writeFile(duplicatePath, duplicate);
  await native([0], 1, duplicatePath);
  const stableKey = createHash("sha256")
    .update("bytorio-save-v1\0" + manifest.save.id)
    .digest("hex");
  const stablePath = resolve(saveDirectory, stableKey + ".sav");
  savedKeys.push(stableKey + ".sav");
  const codeChunk = chunks(stable).find(({ type }) => type === "caRt");
  const addedCode =
    language === "luau" ? Buffer.from("\n-- compatible rebuild\n") : Buffer.from([0, 2, 1, 120]);
  const rebuiltCode = Buffer.concat([codeChunk.data, addedCode]);
  rebuiltCode.writeUInt32LE(codeChunk.data.readUInt32LE(24) + addedCode.length, 24);
  const variants = {
    "original.png": original,
    "stable.png": stable,
    "renamed.png": stable,
    "rebuilt.png": Buffer.concat([
      stable.subarray(0, -12),
      chunk("tEXt", Buffer.from("Build\0revision-two")),
      stable.subarray(-12),
    ]),
    "code.png": Buffer.concat(
      chunks(stable).reduce(
        (parts, part) => [
          ...parts,
          part.type === "caRt"
            ? chunk("caRt", rebuiltCode)
            : stable.subarray(part.offset, part.end),
        ],
        [stable.subarray(0, 8)],
      ),
    ),
    "assets.png": Buffer.concat([
      stable.subarray(0, -12),
      chunk("coNt", encodeContent([{ id: 1, bytes: Buffer.from([42]) }])),
      stable.subarray(-12),
    ]),
    "separate.png": Buffer.concat(
      chunks(stable).reduce(
        (parts, part) => [
          ...parts,
          part.type === "saVe"
            ? chunk("saVe", encodeSaveIdentity({ id: "org.example.other-" + language }))
            : stable.subarray(part.offset, part.end),
        ],
        [stable.subarray(0, 8)],
      ),
    ),
  };
  assert.notDeepEqual(variants["rebuilt.png"], stable);
  for (const [name, bytes] of Object.entries(variants)) {
    await writeFile(resolve(project, "build/web", name), bytes);
  }
  await writeFile(resolve(project, "build/web/game.png"), original);
  await writeFile(saved, Buffer.from([7, 8, 9]));
  assert.equal(
    (await native([0]))[0].sounds,
    1,
    "stable identity adopts first existing legacy save",
  );
  assert.deepEqual(await readFile(stablePath), Buffer.from([7, 8, 9]));
  assert.deepEqual(await readFile(saved), Buffer.from([7, 8, 9]), "legacy copy survives adoption");
  await writeFile(saved, expected);
  for (const name of ["renamed.png", "rebuilt.png", "code.png", "assets.png"]) {
    const frame = (await native([0], 0, resolve(project, "build/web", name)))[0];
    assert.equal(frame.sounds, 1, "canonical bytes win across renamed and changed PNGs");
    assert.deepEqual(await readFile(stablePath), Buffer.from([7, 8, 9]));
  }
  assert.equal((await native([0], 0, resolve(project, "build/web/separate.png")))[0].sounds, 0);
  await writeFile(stablePath, Buffer.alloc(65537));
  await native([4], 1);
  assert.equal(
    (await readFile(stablePath)).length,
    65537,
    "corrupt canonical is neither replaced nor migrated",
  );
  await unlink(stablePath);
  await writeFile(saved, Buffer.alloc(0));
  assert.equal((await native([0]))[0].sounds, 0, "corrupt first legacy fails adoption");
  await assert.rejects(readFile(stablePath), { code: "ENOENT" });
  savedKeys.pop();
  await writeFile(saved, expected);
}

const server = serve(root, 0);
await once(server, "listening");
const browser = await chromium.launch({
  channel: process.env.PLAYER_BROWSER_CHANNEL || "chrome",
  headless: true,
});
try {
  const page = await browser.newPage();
  for (const language of ["odin", "luau"]) {
    await page.goto(`http://127.0.0.1:${server.address().port}/${language}/build/web/player.html`);
    await page.waitForFunction(() => playerStatus.ready || playerStatus.error);
    assert.equal(await page.evaluate(() => playerStatus.error), "");
    const report = await page.evaluate(async () => {
      async function session(url = "./game.png") {
        const worker = new Worker("./worker.js", { type: "module" });
        const request = (message) =>
          new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              worker.terminate();
              reject(new Error("save worker deadline"));
            }, 15000);
            worker.onmessage = async ({ data }) => {
              if (data.type === "executing") {
                return;
              }
              if (data.type === "executor") {
                try {
                  const bytes = await (await fetch("./luau-executor.wasm")).arrayBuffer();
                  worker.postMessage({ type: "executor", executor: { bytes } });
                } catch (error) {
                  clearTimeout(timeout);
                  reject(error);
                }
                return;
              }
              clearTimeout(timeout);
              if (data.type === "error") {
                reject(new Error(data.error));
              } else {
                resolve(data);
              }
            };
            worker.onerror = (error) => {
              clearTimeout(timeout);
              reject(error);
            };
            worker.postMessage(message);
          });
        await request({ type: "load", gameUrl: url });
        const step = (buttons = 0) =>
          request({
            type: "step",
            steps: 1,
            render: true,
            input: { buttons, pointer: false, x: 0, y: 0 },
          });
        const committed = async (frame) => {
          for (let i = 0; i < 100 && frame.y === 2; i++) {
            frame = await step();
          }
          if (frame.y !== 1) {
            throw new Error(`save did not commit: ${frame.y}`);
          }
          return frame;
        };
        return { worker, step, committed };
      }
      let game = await session();
      let frame = await game.step();
      if (frame.x !== 0 || frame.y !== 0) {
        throw new Error("new cartridge must start empty");
      }
      frame = await game.committed(await game.step(16));
      if (frame.x * 16 !== 65536) {
        throw new Error("maximum save length missing");
      }
      await game.step();
      frame = await game.step(2);
      if (frame.sounds !== 1) {
        throw new Error("saved bytes differ from expected pattern");
      }
      await game.step();
      frame = await game.step(1);
      if (frame.sounds !== 2) {
        throw new Error("bounds checks failed");
      }
      game.worker.terminate();
      game = await session();
      frame = await game.step();
      if (frame.x * 16 !== 65536 || frame.y !== 1 || frame.sounds !== 1) {
        throw new Error("restart lost committed save");
      }
      await game.committed(await game.step(8));
      game.worker.terminate();
      game = await session();
      frame = await game.step();
      if (frame.x * 16 !== 4096 || frame.y !== 1 || frame.sounds !== 1) {
        throw new Error("legacy-size record did not remain readable");
      }
      await game.committed(await game.step(4));
      game.worker.terminate();
      game = await session();
      frame = await game.step();
      if (frame.x * 16 !== 3 || frame.y !== 1 || frame.sounds !== 1) {
        throw new Error("replacement did not persist");
      }
      game.worker.terminate();
      const final = { length: frame.x * 16, state: frame.y, sounds: frame.sounds };
      game = await session("./stable.png");
      frame = await game.step();
      if (frame.x * 16 !== 3 || frame.y !== 1 || frame.sounds !== 1) {
        throw new Error("stable migration failed");
      }
      await game.committed(await game.step(16));
      game.worker.terminate();
      for (const url of ["./renamed.png", "./rebuilt.png", "./code.png", "./assets.png"]) {
        game = await session(url);
        frame = await game.step();
        if (frame.x * 16 !== 65536 || frame.y !== 1 || frame.sounds !== 1) {
          throw new Error("rebuild lost canonical save");
        }
        game.worker.terminate();
      }
      game = await session("./original.png");
      frame = await game.step();
      if (frame.x * 16 !== 3) {
        throw new Error("migration modified old copy");
      }
      game.worker.terminate();
      game = await session("./separate.png");
      frame = await game.step();
      if (frame.x !== 0 || frame.y !== 0) {
        throw new Error("unrelated identity shares saves");
      }
      game.worker.terminate();
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("bytorio-saves-v1", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const records = await new Promise((resolve, reject) => {
        const tx = database.transaction("slots", "readonly"),
          store = tx.objectStore("slots");
        const keys = store.getAllKeys(),
          values = store.getAll();
        tx.oncomplete = () =>
          resolve(keys.result.map((key, i) => ({ key, value: values.result[i] })));
        tx.onerror = () => reject(tx.error);
      });
      // There is one canonical maximum-size record for this language at this point.
      const stableBytes = await (await fetch("./stable.png")).arrayBuffer();
      const { decodeCartridge } = await import("./cartridge.js");
      const runtime = (
        await WebAssembly.instantiate(await (await fetch("./runtime.wasm")).arrayBuffer(), {
          env: { sin: Math.sin },
        })
      ).instance.exports;
      const metadata = decodeCartridge(runtime, stableBytes);
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode("bytorio-save-v1\0" + metadata.saveId),
      );
      const stableKey = [...new Uint8Array(digest)]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("");
      if (records.find((r) => r.key === stableKey)?.value.length !== 65536) {
        throw new Error("canonical key mismatch");
      }
      await new Promise((resolve, reject) => {
        const tx = database.transaction("slots", "readwrite");
        tx.objectStore("slots").put(undefined, stableKey);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      game = await session("./stable.png");
      frame = await game.step();
      if (frame.x !== 0 || frame.y !== 3) {
        throw new Error("corrupt canonical fell back");
      }
      game.worker.terminate();
      const { openSaveSlot } = await import("./save.js");
      const memory = new WebAssembly.Memory({ initial: 1 });
      const originalAdd = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (...args) {
        const request = originalAdd.apply(this, args);
        this.transaction.abort();
        return request;
      };
      try {
        const failed = await openSaveSlot(new Uint8Array(), () => ({ memory }), {
          ...metadata,
          saveId: metadata.saveId + ".failure",
        });
        if (failed.imports.save_status() !== 3) {
          throw new Error("migration failure not reported");
        }
        failed.close();
      } finally {
        IDBObjectStore.prototype.add = originalAdd;
      }
      const competing = await Promise.all(
        Array.from({ length: 3 }, () =>
          openSaveSlot(new Uint8Array(), () => ({ memory }), {
            ...metadata,
            saveId: metadata.saveId + ".race",
          }),
        ),
      );
      for (const slot of competing) {
        if (slot.imports.save_status() !== 1 || slot.imports.save_size() !== 3) {
          throw new Error("concurrent adoption failed");
        }
        slot.close();
      }
      database.close();
      return final;
    });
    assert.deepEqual(report, { length: 3, state: 1, sounds: 1 });
  }
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
console.log(
  "Save conformance passed: both SDKs/native/browser, 64 KiB snapshots, legacy-size restart, cartridge isolation, atomic replacement, rollback and bounds.",
);
