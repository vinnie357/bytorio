import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chunk, chunks, encodeCartridge, signature } from "../sdk/cartridge.mjs";
import { gameSource } from "./luau-source.mjs";

const assets = JSON.parse(
  readFileSync(new URL("../../sdk/templates/assets.json", import.meta.url)),
);

export function sourceCode(bytes) {
  const source = gameSource(Math.max(0, bytes - 4096));
  assert.ok(Buffer.byteLength(source) <= bytes, "room fixture must fit before newline padding");
  return Buffer.from(source.padEnd(bytes, "\n"));
}

export function packSource(code) {
  return encodeCartridge({
    title: "Luau source limit",
    language: "luau",
    display: [640, 360],
    code,
    assets,
  });
}

// Bypass only the packer's size check so each parser sees a valid container independently.
export function sourcePng(code) {
  const small = packSource(Buffer.from(gameSource(0)));
  return Buffer.concat([
    signature,
    ...chunks(small).map(({ type, data }) => {
      if (type !== "caRt") {
        return chunk(type, data);
      }
      const prefix = Buffer.from(data.subarray(0, 32 + data.readUInt32LE(20)));
      prefix.writeUInt32LE(code.length, 24);
      return chunk(type, Buffer.concat([prefix, code]));
    }),
  ]);
}
