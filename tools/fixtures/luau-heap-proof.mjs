import { readFile } from "node:fs/promises";
import { loadSource } from "../../runtime/odin/web/policy.js";

export function heapGameSource({ growing = false } = {}) {
  return `
local live = {}
local ticks = 0
local checksum = 0
local game = {}
local function row(id)
    local values = table.create(24)
    for index = 1, 24 do values[index] = id + index end
    return { id = id, name = string.format("unit_%06d", id), values = values }
end
function game.init()
    for id = 1, ${growing ? 0 : 3200} do live[id] = row(id) end
end
function game.update()
    ticks += 1
    ${
      growing
        ? `for index = 1, 256 do
        local id = #live + 1
        live[id] = row(id)
    end`
        : `local temporary = {}
    for index = 1, 512 do
        temporary[index] = row(ticks * 512 + index)
        checksum += temporary[index].values[5]
    end
    local id = (ticks * 37) % #live + 1
    assert(#live == 3200 and live[id].id == id)
    assert(live[id].name == string.format("unit_%06d", id))
    assert(live[id].values[5] == id + 5 and checksum > 0)`
    }
end
function game.draw() console.debug_position(${growing ? "ticks" : "#live"}, ticks) end
return game
`;
}

export async function heapExecutor(source) {
  const bytes = await readFile(
    new URL("../../build/luau-executor/luau-executor.wasm", import.meta.url),
  );
  const names = [
    "content_size",
    "content_read",
    "save_size",
    "save_status",
    "save_read",
    "save_write",
    "text_configure",
    "text_read",
  ];
  const imports = { env: Object.fromEntries(names.map((name) => [name, () => 0])) };
  const game = (await WebAssembly.instantiate(bytes, imports)).instance.exports;
  game._initialize?.();
  loadSource(game, Buffer.from(source));
  return game;
}
