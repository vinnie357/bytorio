import { MAX_GAME_BYTES, MAX_LUAU_SOURCE_BYTES } from "../../runtime/odin/web/constants.js";
import { deflateSync } from "node:zlib";
import contract from "../../sdk/contract.json" with { type: "json" };

export const PNG_LIMIT = contract.cartridge.maxPngBytes;
export const CONTENT_LIMIT = contract.cartridge.content.maxBytes;
export const CARTRIDGE_LIMIT = PNG_LIMIT + CONTENT_LIMIT + 12;
export const signature = Buffer.from("89504e470d0a1a0a", "hex");
const CRC32_POLYNOMIAL = 0xedb88320;
const CRC32_INITIAL = 0xffffffff;
const CRC32_XOR_OUT = 0xffffffff;
const table = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) {
    value = value & 1 ? CRC32_POLYNOMIAL ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});
export function crc32(bytes) {
  let crc = CRC32_INITIAL;
  for (const byte of bytes) {
    crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  }
  return (crc ^ CRC32_XOR_OUT) >>> 0;
}
export function chunk(type, data) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 4, "ascii");
  result.set(data, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}
export function chunks(bytes) {
  if (bytes.length > CARTRIDGE_LIMIT || !bytes.subarray(0, 8).equals(signature)) {
    throw new Error("Invalid PNG signature or size");
  }
  const result = [];
  for (let offset = 8; offset < bytes.length && result.length < 4096;) {
    if (bytes.length - offset < 12) {
      throw new Error("Truncated PNG chunk");
    }
    const length = bytes.readUInt32BE(offset),
      end = offset + length + 12;
    if (end > bytes.length) {
      throw new Error("PNG chunk outside file");
    }
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) {
      throw new Error("PNG chunk checksum mismatch");
    }
    result.push({ type, offset, end, data: bytes.subarray(offset + 8, end - 4) });
    offset = end;
    if (type === "IEND") {
      if (length || end !== bytes.length) {
        throw new Error("Invalid PNG end chunk");
      }
      return result;
    }
  }
  throw new Error("Missing PNG end chunk or too many chunks");
}

export function defaultCover({ title, language, assets }) {
  const width = 256,
    height = 256;
  const pixels = Buffer.alloc(width * height * 4);
  const put = (x, y, color) => {
    if (x < 0 || y < 0 || x >= width || y >= height) {
      return;
    }
    const i = (y * width + x) * 4;
    pixels[i] = parseInt(color.slice(1, 3), 16);
    pixels[i + 1] = parseInt(color.slice(3, 5), 16);
    pixels[i + 2] = parseInt(color.slice(5, 7), 16);
    pixels[i + 3] = 255;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      put(x, y, x < 8 || y < 8 || x >= 248 || y >= 248 ? "#61a65a" : "#152032");
    }
  }
  const text = (value, x, y, scale = 2) => {
    for (const [index, character] of [...value.toUpperCase()].entries()) {
      if (character === " ") {
        continue;
      }
      const rows = assets.font?.[character] || assets.font?.["?"] || [];
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (rows[row]?.[col] !== "1") {
            continue;
          }
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              put(x + index * 6 * scale + col * scale + dx, y + row * scale + dy, "#fff4d4");
            }
          }
        }
      }
    }
  };
  const label = [...title].slice(0, 54).join("");
  for (let line = 0; line < 3; line++) {
    text(label.slice(line * 18, line * 18 + 18), 20, 24 + line * 20);
  }
  const sprite = assets.sprites[0];
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (sprite[y][x] === ".") {
        continue;
      }
      for (let dy = 0; dy < 6; dy++) {
        for (let dx = 0; dx < 6; dx++) {
          put(80 + x * 6 + dx, 102 + y * 6 + dy, assets.palette[parseInt(sprite[y][x], 16)]);
        }
      }
    }
  }
  text(`${language} GAME`, 20, 218);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    pixels.copy(scanlines, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function encodeContent(entries) {
  const limits = contract.cartridge.content;
  if (!Array.isArray(entries) || entries.length > limits.maxEntries) {
    throw new Error("Invalid cartridge content entries");
  }
  if (entries.length === 0) {
    return null;
  }
  const sorted = [...entries].sort((a, b) => a.id - b.id);
  const headerBytes = limits.headerBytes + sorted.length * limits.recordBytes;
  let total = headerBytes;
  let previous = 0;
  for (const { id, bytes } of sorted) {
    if (
      !Number.isInteger(id) ||
      id <= previous ||
      id > 0xffffffff ||
      !(bytes instanceof Uint8Array) ||
      !bytes.length
    ) {
      throw new Error("Content IDs must be unique positive u32 values with nonempty byte data");
    }
    previous = id;
    total += bytes.length;
    if (total > limits.maxBytes) {
      throw new Error("Cartridge content exceeds its byte limit");
    }
  }
  const result = Buffer.alloc(total);
  result.writeUInt32LE(limits.magic, limits.headerFields.magic);
  result.writeUInt32LE(limits.version, limits.headerFields.version);
  result.writeUInt32LE(sorted.length, limits.headerFields.count);
  let offset = 0;
  sorted.forEach(({ id, bytes }, i) => {
    const record = limits.headerBytes + i * limits.recordBytes;
    result.writeUInt32LE(id, record + limits.recordFields.id);
    result.writeUInt32LE(offset, record + limits.recordFields.offset);
    result.writeUInt32LE(bytes.length, record + limits.recordFields.length);
    result.set(bytes, headerBytes + offset);
    offset += bytes.length;
  });
  return result;
}

export function encodeSaveIdentity(save) {
  if (save === undefined) {
    return null;
  }
  const limits = contract.save;
  if (
    !save ||
    typeof save !== "object" ||
    Array.isArray(save) ||
    Object.keys(save).some((key) => !["id", "legacy"].includes(key)) ||
    typeof save.id !== "string" ||
    save.id.length > limits.maxIdentityBytes ||
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(save.id)
  ) {
    throw new Error(
      "save.id must be 1..128 lowercase ASCII letters/digits with dot or hyphen separators",
    );
  }
  const legacy = save.legacy === undefined ? [] : save.legacy;
  if (
    !Array.isArray(legacy) ||
    legacy.length > limits.maxLegacyKeys ||
    legacy.some((key) => typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key)) ||
    new Set(legacy).size !== legacy.length
  ) {
    throw new Error("save.legacy must contain at most 16 unique lowercase SHA-256 hex keys");
  }
  const header = Buffer.from([limits.identityVersion, save.id.length, legacy.length, 0]);
  return Buffer.concat([
    header,
    Buffer.from(save.id, "ascii"),
    ...legacy.map((key) => Buffer.from(key, "hex")),
  ]);
}

export function encodeCartridge({
  title,
  language,
  display,
  code,
  cover,
  assets,
  content = [],
  save,
  profile = "2d-preview-1",
}) {
  const requirements = contract.profiles.find((item) => item.name === profile);
  if (!requirements) {
    throw new Error("Unsupported cartridge profile");
  }
  if (
    typeof title !== "string" ||
    [...title].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  ) {
    throw new Error("Invalid cartridge title");
  }
  const name = Buffer.from(title, "utf8");
  if (name.length < 1 || name.length > 128 || name.toString("utf8") !== title) {
    throw new Error("Cartridge title must be 1..128 UTF-8 bytes");
  }
  const kind = language === "luau" ? 1 : language === "odin" ? 2 : 0;
  if (
    !kind ||
    !code.length ||
    code.length > (kind === 1 ? MAX_LUAU_SOURCE_BYTES : MAX_GAME_BYTES)
  ) {
    throw new Error("Invalid cartridge language or code size");
  }
  if (
    ![
      [640, 360],
      [320, 180],
    ].some(([w, h]) => display?.[0] === w && display?.[1] === h)
  ) {
    throw new Error("Unsupported cartridge display");
  }
  const header = Buffer.alloc(32);
  header.write("CART");
  header.writeUInt16LE(1, 4);
  header[6] = kind;
  header[7] = requirements.id;
  header.writeUInt32LE(requirements.sdkWord, 8);
  header.writeUInt32LE(requirements.abi, 12);
  header.writeUInt16LE(display[0], 16);
  header.writeUInt16LE(display[1], 18);
  header.writeUInt32LE(name.length, 20);
  header.writeUInt32LE(code.length, 24);
  const image = cover || defaultCover({ title, language, assets });
  const parts = chunks(image);
  if (
    parts.some(
      ({ type }) => type === "caRt" || type === "coNt" || type === contract.save.identityChunk,
    )
  ) {
    throw new Error("Cover already contains a cartridge");
  }
  const end = parts.at(-1).offset;
  const contentBytes = encodeContent(content);
  const saveBytes = encodeSaveIdentity(save);
  const png = Buffer.concat([
    image.subarray(0, end),
    chunk("caRt", Buffer.concat([header, name, code])),
    ...(saveBytes ? [chunk(contract.save.identityChunk, saveBytes)] : []),
    ...(contentBytes ? [chunk("coNt", contentBytes)] : []),
    image.subarray(end),
  ]);
  if (png.length - (contentBytes ? contentBytes.length + 12 : 0) > PNG_LIMIT) {
    throw new Error(`PNG cartridge exceeds base size limit (${PNG_LIMIT} bytes)`);
  }
  return png;
}
