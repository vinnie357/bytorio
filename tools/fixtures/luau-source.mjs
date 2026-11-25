// Keep the workload executable: short strings, numeric arrays and per-room functions.
export function gameSource(
  minimumBytes,
  tail = `
local game = {}
function game.init() end
function game.update() end
function game.draw() console.clear(0xff102030) end
return game
`,
) {
  const parts = ["local rooms = {}\n"];
  let bytes = Buffer.byteLength(parts[0]) + Buffer.byteLength(tail);
  for (let room = 1; bytes < minimumBytes; room++) {
    const rows = Array.from(
      { length: 24 },
      (_, row) => `        { key = "kitten_${row}", position = { ${row}, ${room}, 3, 4 } },\n`,
    ).join("");
    const source = `function rooms.room_${room}()\n    local entities = {\n${rows}    }\n    return entities\nend\n`;
    parts.push(source);
    bytes += Buffer.byteLength(source);
  }
  return parts.join("") + tail;
}
