import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { format as prettierFormat } from "prettier";
import { formatSource } from "./code-tools.mjs";
import { branding } from "./branding.mjs";
import { srgbLinearSample } from "./srgb.mjs";
const root = new URL("../", import.meta.url);
const schema = JSON.parse(await readFile(new URL("sdk/resource-protocol.json", root)));
const constants = Object.fromEntries(
  Object.entries(schema).filter(([, value]) => typeof value === "number"),
);
// Resource IDs pack a slot index below a generation counter in one u32.
constants.handleIndexMask = 2 ** schema.handleIndexBits - 1;
constants.handleGenerationStride = 2 ** schema.handleIndexBits;
constants.maxHandleGeneration = 2 ** schema.handleGenerationBits - 1;
if (
  schema.handleIndexBits + schema.handleGenerationBits !== 32 ||
  schema.maxSlots > constants.handleIndexMask
) {
  throw new Error("Invalid resource handle layout.");
}
for (const [name, value] of Object.entries(schema.opcodes)) {
  constants[`op_${name}`] = value;
}
for (const [name, value] of Object.entries(schema.formats)) {
  constants[`format_${name}`] = value;
}
for (const [name, value] of Object.entries(schema.nodes)) {
  constants[`node_${name}`] = value;
}
for (const [name, value] of Object.entries(schema.parameters)) {
  constants[`param_${name}`] = value;
}
constants.colorTableBytes = schema.paletteEntries * schema.paletteEntries;
constants.graphicsFixedOne = 2 ** schema.graphicsFractionBits;
constants.mailboxMagic = schema.mailbox.magic;
constants.mailboxHeaderBytes = schema.mailbox.headerBytes;
constants.mailboxRecordBytes = schema.mailbox.recordBytes;
constants.mailboxMaxRecords = schema.mailbox.maxRecords;
constants.mailboxPayloadOffset =
  constants.mailboxHeaderBytes + constants.mailboxMaxRecords * constants.mailboxRecordBytes;
constants.legacyMailboxPayloadOffset = constants.mailboxPayloadOffset;
constants.legacyMailboxCapacity = constants.mailboxPayloadOffset + schema.maxCompletionPayload;
constants.audioStatusOffset = constants.mailboxPayloadOffset;
constants.mailboxPayloadOffset += schema.audioStatusBytes;
constants.mailboxCapacity = constants.mailboxPayloadOffset + schema.maxCompletionPayload;
constants.maxAudioLeases =
  schema.maxAudioEvents +
  schema.maxVoices +
  schema.maxStreams * schema.maxStreamChunks +
  schema.maxSlots +
  schema.maxInstruments +
  schema.maxBuses;
constants.maxAudioDoneRecords = constants.maxAudioLeases + schema.maxAudioEvents + schema.maxVoices;
constants.audioEventBytes = 96;
constants.maxAudioPacketBytes =
  constants.audioPacketHeaderBytes +
  schema.maxAudioEvents * constants.audioEventBytes +
  schema.maxAudioSnapshotBytes;
constants.maxAudioFeedbackBytes = 80 + constants.maxAudioDoneRecords * 32;
const contract = JSON.parse(await readFile(new URL("sdk/contract.json", root)));
const saveIdentityStrings = {
  SAVE_IDENTITY_PREFIX: contract.save.identityPrefix,
  SAVE_IDENTITY_CHUNK: contract.save.identityChunk,
};
const valueTypes = { i32: 127, f64: 124 };
const exportSignatures = Object.entries(contract.requiredExports).map(([name, signature]) => {
  const [, input, output] = signature.match(/^\(([^)]*)\) -> (.*)$/);
  const types = (value) =>
    value
      .replace(/[()\s]/g, "")
      .split(",")
      .filter(Boolean)
      .map((type) => {
        if (!valueTypes[type]) {
          throw new Error(`Unsupported export type: ${type}`);
        }
        return valueTypes[type];
      });
  return { name, params: types(input), results: types(output) };
});
// Numeric encodings are fixed-width; policy limits and defaults come from the contract.
const common = {
  MAX_CARTRIDGE_BASE_BYTES: contract.cartridge.maxPngBytes,
  MAX_CARTRIDGE_BYTES: contract.cartridge.maxPngBytes + contract.cartridge.content.maxBytes + 12,
  CONTENT_VERSION: contract.cartridge.content.version,
  CONTENT_MAGIC: contract.cartridge.content.magic,
  ...Object.fromEntries(
    Object.entries(contract.cartridge.content.headerFields).map(([name, offset]) => [
      `CONTENT_HEADER_${name.toUpperCase()}`,
      offset,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(contract.cartridge.content.recordFields).map(([name, offset]) => [
      `CONTENT_RECORD_${name.toUpperCase()}`,
      offset,
    ]),
  ),
  CONTENT_HEADER_BYTES: contract.cartridge.content.headerBytes,
  CONTENT_RECORD_BYTES: contract.cartridge.content.recordBytes,
  MAX_CONTENT_ENTRIES: contract.cartridge.content.maxEntries,
  MAX_CONTENT_BYTES: contract.cartridge.content.maxBytes,
  MAX_CONTENT_READ_BYTES: contract.cartridge.content.maxReadBytes,
  PROFILE_EFFECTS_3D: contract.profiles[5].id,
  PROFILE_OGG: contract.profiles[6].id,
  OGG_SDK: contract.profiles[6].sdkWord,
  OGG_FEATURES: contract.profiles[6].features,
  OGG_PROTOCOL: contract.profiles[6].protocol,
  EFFECTS_3D_SDK: contract.profiles[5].sdkWord,
  EFFECTS_3D_FEATURES: contract.profiles[5].features,
  EFFECTS_3D_PROTOCOL: contract.profiles[5].protocol,
  PROFILE_ALPHA_3D: contract.profiles[4].id,
  ALPHA_3D_SDK: contract.profiles[4].sdkWord,
  ALPHA_3D_FEATURES: contract.profiles[4].features,
  ALPHA_3D_PROTOCOL: contract.profiles[4].protocol,
  PROFILE_TEXTURED_3D: contract.profiles[3].id,
  TEXTURED_3D_SDK: contract.profiles[3].sdkWord,
  TEXTURED_3D_FEATURES: contract.profiles[3].features,
  TEXTURED_3D_PROTOCOL: contract.profiles[3].protocol,
  PROFILE_3D: contract.profiles[2].id,
  PREVIEW_3D_SDK: contract.profiles[2].sdkWord,
  PREVIEW_3D_FEATURES: contract.profiles[2].features,
  PREVIEW_3D_PROTOCOL: contract.profiles[2].protocol,
  PROFILE_RESOURCE: contract.cartridge.profileId,
  RESOURCE_ABI_VERSION: contract.abiVersion,
  RESOURCE_SDK_VERSION: contract.sdkVersionWord,
  RESOURCE_FEATURES: contract.profiles[1].features,
  RESOURCE_PROTOCOL: contract.profiles[1].protocol,
  FRAME_BYTES: contract.records.frame.bytes,
  MAX_GAME_BYTES: contract.limits.moduleBytes,
  MAX_MEMORY_BYTES: contract.limits.guestMemoryBytes,
  MAX_COMMANDS: contract.limits.commands,
  MAX_TEXT_BYTES: contract.limits.textBytes,
  MAX_GRAPHICS_BYTES: contract.limits.graphicsBytes,
  MAX_LUAU_SOURCE_BYTES: contract.limits.luauSourceBytes,
  MAX_LUAU_MEMORY_BYTES: contract.limits.luauMemoryBytes,
  MAX_LUAU_HEAP_BYTES: contract.limits.luauHeapBytes,
  U32_MAX: 2 ** 32 - 1,
  U32_MODULUS: 2 ** 32,
  WASM_PAGE_BYTES: 2 ** 16,
  COLOR_CHANNEL_MAX: 255,
  COLOR_GREEN_SCALE: 2 ** 8,
  COLOR_BLUE_SCALE: 2 ** 16,
  COLOR_ALPHA_SCALE: 2 ** 24,
  COLOR_OPAQUE_BLACK: 0xff000000,
  COLOR_OPAQUE_WHITE: 0xffffffff,
  FNV1A_OFFSET_BASIS: 2166136261,
  FNV1A_PRIME: 16777619,
  PREVIEW_SAMPLE_RATE: contract.defaults.previewSampleRate,
  DEFAULT_CLEAR_COLOR: contract.defaults.clearColor,
  DEFAULT_RANDOM_SEED: contract.defaults.randomSeed,
  RANDOM_ZERO_SEED_FALLBACK: contract.defaults.zeroSeedFallback,
  COORDINATE_MIN: contract.limits.coordinateMin,
  COORDINATE_MAX: contract.limits.coordinateMax,
  MAX_TEXT_BYTES_PER_COMMAND: contract.limits.textBytesPerCommand,
  LEGACY_BUTTON_MASK: Object.values(contract.buttons).reduce((mask, bit) => mask | bit, 0),
  INPUT_VERSION: contract.inputVersion,
  TEXT_INPUT_VERSION: contract.textInput.version,
  TEXT_INPUT_MAX_BYTES: contract.textInput.maxBytes,
  TEXT_INPUT_HEADER_BYTES: contract.textInput.headerBytes,
  ...Object.fromEntries(
    Object.entries(contract.textInput.flags).map(([name, value]) => [
      `TEXT_INPUT_${name.toUpperCase()}`,
      value,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(contract.textInput.fields).map(([name, value]) => [
      `TEXT_INPUT_FIELD_${name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`,
      value,
    ]),
  ),
  SAVE_IDENTITY_VERSION: contract.save.identityVersion,
  MAX_SAVE_IDENTITY_BYTES: contract.save.maxIdentityBytes,
  MAX_SAVE_LEGACY_KEYS: contract.save.maxLegacyKeys,
  SAVE_IDENTITY_HEADER_BYTES: contract.save.identityHeaderBytes,
  SAVE_DIGEST_BYTES: contract.save.digestBytes,
  SAVE_VERSION: contract.save.version,
  MAX_SAVE_BYTES: contract.save.maxBytes,
  ...Object.fromEntries(
    Object.entries(contract.save.status).map(([name, value]) => [
      `SAVE_${name.toUpperCase()}`,
      value,
    ]),
  ),
  INPUT_BUTTON_MASK: [
    ...Object.values(contract.buttons),
    ...Object.values(contract.extendedButtons),
  ].reduce((mask, bit) => (mask | bit) >>> 0, 0),
  ...Object.fromEntries(
    Object.entries({ ...contract.buttons, ...contract.extendedButtons }).map(([name, bit]) => [
      `BUTTON_${name.toUpperCase()}`,
      bit,
    ]),
  ),
};
const files = {
  "runtime/odin/branding/branding.odin":
    "// Generated by tools/generate-constants.mjs from package.json.\npackage branding\n\n" +
    Object.entries({
      PRODUCT_NAME: branding.name,
      WEBSITE: branding.website,
      PLAYER_TITLE: branding.playerTitle,
    })
      .map(([key, value]) => `${key} :: ${JSON.stringify(value)}\n`)
      .join(""),
  "runtime/odin/resource_protocol/schema.odin":
    "// Generated by tools/generate-constants.mjs.\npackage resource_protocol\n\n" +
    Object.entries(constants)
      .map(([key, value]) => `${key} :: ${value}\n`)
      .join(""),
  "sdk/luau/resource_schema.luau":
    "--!strict\n-- Generated by tools/generate-constants.mjs.\nreturn table.freeze({\n" +
    Object.entries(constants)
      .filter(
        ([key]) =>
          ![
            "oggProtocol",
            "maxOggStreams",
            "maxOggSourceBytes",
            "maxOggEncodedBytes",
            "maxOggDecoderBytes",
            "oggChunkFrames",
            "oggRequestWords",
            "op_audio_stream_end",
          ].includes(key),
      )
      .map(([key, value]) => `    ${key} = ${value},\n`)
      .join("") +
    "})\n",
  "experiments/luau-executor/resource_schema.h":
    "// Generated by tools/generate-constants.mjs.\n#pragma once\nnamespace resource_schema {\n" +
    Object.entries(constants)
      .map(
        ([key, value]) =>
          `constexpr ${value > 2 ** 32 - 1 ? "unsigned long long" : "unsigned"} ${key} = ${value}${value > 2 ** 32 - 1 ? "ull" : ""};\n`,
      )
      .join("") +
    "}\n",
};
files["runtime/odin/resources/srgb_table.odin"] =
  "// Generated by tools/generate-constants.mjs.\npackage resources\n\n" +
  "SOFTWARE_SRGB_DECODE := [256]f64{\n" +
  Array.from({ length: 256 }, (_, i) => srgbLinearSample(i, 255).toPrecision(17) + ",\n").join("") +
  "}\n" +
  "SOFTWARE_SRGB_THRESHOLDS := [255]f64{\n" +
  Array.from(
    { length: 255 },
    (_, i) => srgbLinearSample(i * 2 + 1, 510).toPrecision(17) + ",\n",
  ).join("") +
  "}\n";
files["runtime/vorbis/limits.h"] =
  "// Generated by tools/generate-constants.mjs.\n#pragma once\n" +
  [
    "maxOggStreams",
    "maxOggSourceBytes",
    "maxOggEncodedBytes",
    "maxOggDecoderBytes",
    "oggChunkFrames",
    "audioRate",
  ]
    .map((key) => `#define ${key} ${constants[key]}\n`)
    .join("");
files["runtime/odin/abi/constants.odin"] =
  "// Generated by tools/generate-constants.mjs.\npackage abi\n\n" +
  Object.entries(saveIdentityStrings)
    .map(([key, value]) => key + " :: " + JSON.stringify(value) + "\n")
    .join("") +
  Object.entries(common)
    .map(([key, value]) => key + " :: " + value + "\n")
    .join("");
const typeString = (types) => '"' + types.map((type) => "\\x" + type.toString(16)).join("") + '"';
files["runtime/odin/abi/profile_exports.odin"] =
  `// Generated by tools/generate-constants.mjs.\npackage abi\n\nProfile_Export :: struct { name, params, results: string }\nRESOURCE_EXPORTS := [${exportSignatures.length}]Profile_Export{\n` +
  exportSignatures
    .map(
      ({ name, params, results }) =>
        `{${JSON.stringify(name)},${typeString(params)},${typeString(results)}},\n`,
    )
    .join("") +
  "}\n";
files["sdk/luau/constants.luau"] =
  "--!strict\n-- Generated by tools/generate-constants.mjs.\nreturn table.freeze({\n" +
  Object.entries(common)
    // Luau negotiates through PROFILES. These named values are host-only.
    .filter(([key]) => !["PROFILE_OGG", "OGG_SDK", "OGG_FEATURES", "OGG_PROTOCOL"].includes(key))
    .map(([key, value]) => "    " + key + " = " + value + ",\n")
    .join("") +
  "    PROFILES = table.freeze({\n" +
  contract.profiles
    .map(
      ({ id, sdk, sdkWord, features, protocol }) =>
        `        [${id}] = table.freeze({version=${JSON.stringify(sdk)},sdk=${sdkWord},features=${features},protocol=${protocol}}),\n`,
    )
    .join("") +
  "    }),\n" +
  "})\n";
files["experiments/luau-executor/console_constants.h"] =
  "// Generated by tools/generate-constants.mjs.\n#pragma once\n#include <cstdint>\nnamespace console_constants {\n" +
  Object.entries(common)
    .map(
      ([key, value]) =>
        "constexpr auto " +
        key +
        " = " +
        value +
        (value > 2 ** 32 - 1 ? "ull" : value < 0 ? "" : "u") +
        ";\n",
    )
    .join("") +
  "}\n";
files["runtime/odin/web/constants.js"] =
  "// Generated by tools/generate-constants.mjs.\n" +
  Object.entries({
    ...saveIdentityStrings,
    PRODUCT_NAME: branding.name,
    WEBSITE: branding.website,
    PLAYER_TITLE: branding.playerTitle,
  })
    .map(([key, value]) => `export const ${key} = ${JSON.stringify(value)};\n`)
    .join("") +
  Object.entries(common)
    .map(([key, value]) => "export const " + key + " = " + value + ";\n")
    .join("") +
  "export const RESOURCE_EXPORTS = Object.freeze(" +
  JSON.stringify(exportSignatures) +
  ");\n" +
  "export const resourceSchema = Object.freeze(" +
  JSON.stringify(constants, null, 2) +
  ");\n";
for (const [file, content] of Object.entries(files)) {
  const target = new URL(file, root);
  const formatted = file.endsWith(".js")
    ? await prettierFormat(content, {
        parser: "babel",
        ...JSON.parse(await readFile(new URL(".prettierrc.json", root))),
      })
    : formatSource(content, file);
  if (process.argv.includes("--check")) {
    if ((await readFile(target, "utf8")).replaceAll("\r\n", "\n") !== formatted) {
      throw new Error(`Stale generated constants: ${fileURLToPath(target)}`);
    }
  } else {
    await mkdir(new URL("./", target), { recursive: true });
    await writeFile(target, formatted);
  }
}
console.log(
  `${branding.name} constants ${process.argv.includes("--check") ? "checked" : "generated"}.`,
);
