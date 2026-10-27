--!strict
local c = require("./constants")
local host = require("./native")
local resources = require("./resources")
local schema = require("./resource_schema")
export type Texture = resources.Texture
export type Mesh = resources.Mesh
export type TexturedMesh = resources.TexturedMesh
export type Material = resources.Material
export type EffectOptions = resources.EffectOptions
export type Depth = resources.Depth
export type Camera = resources.Camera
export type Voxel = resources.Voxel
export type Target = resources.Target
export type Palette = resources.Palette
export type ColorTable = resources.ColorTable
export type RowTable = resources.RowTable
export type Pipeline = resources.Pipeline
export type Readback = resources.Readback
export type Pass = resources.Pass
export type Sample = resources.Sample
export type Wavetable = resources.Wavetable
export type Instrument = resources.Instrument
export type SynthNode = resources.SynthNode
export type AudioParameter = resources.Parameter
export type Bus = resources.Bus
export type Stream = resources.Stream
export type Voice = resources.Voice
export type AudioStatus = resources.AudioStatus
export type AudioCompletion = resources.Completion
export type PixelBuffer = resources.PixelBuffer
export type BillboardDesc = resources.BillboardDesc
export type PCMBuffer = resources.PCMBuffer
export type Button =
    "left"
    | "right"
    | "up"
    | "down"
    | "action"
    | "move_left"
    | "move_right"
    | "move_up"
    | "move_down"
    | "pan_left"
    | "pan_right"
    | "pan_up"
    | "pan_down"
    | "rotate_left"
    | "rotate_right"
    | "reset"
    | "pointer_left"
    | "pointer_right"
    | "pointer_hover"
    | "wheel_up"
    | "wheel_down"
    | "inventory"
    | "character"
    | "skills"
    | "quest"
    | "map"
    | "potion_1"
    | "potion_2"
    | "potion_3"
    | "potion_4"
    | "shift"
    | "escape"
export type Game = { init: () -> (), update: (number) -> (), draw: () -> () }
local profileQuery = host.profile
local profile = if profileQuery then profileQuery() else 1
local selected = c.PROFILES[profile]
assert(selected, "Unsupported cartridge profile")
local api = { version = selected.version, content = require("./content") }
api.save = require("./save")
api.text_input = require("./text")
function api.capabilities()
    return table.freeze({
        profile = profile,
        input_version = c.INPUT_VERSION,
        abi = if profile ~= 1 then c.RESOURCE_ABI_VERSION else 1,
        sdk = selected.sdk,
        features = selected.features,
        protocol = selected.protocol,
        resource_bytes = schema.maxResourceBytes,
        slots = schema.maxSlots,
        payload_bytes = schema.maxPayload,
        audio_rate = schema.audioRate,
        audio_lead_frames = schema.audioLeadFrames,
    })
end
api.gfx = resources.gfx
api.gfx3d = resources.gfx3d
api.audio = resources.audio
api.data = resources.data
local masks = { left = 1, right = 2, up = 4, down = 8, action = 16 }
masks.move_left, masks.move_right = c.BUTTON_MOVE_LEFT, c.BUTTON_MOVE_RIGHT
masks.move_up, masks.move_down = c.BUTTON_MOVE_UP, c.BUTTON_MOVE_DOWN
masks.pan_left, masks.pan_right = c.BUTTON_PAN_LEFT, c.BUTTON_PAN_RIGHT
masks.pan_up, masks.pan_down = c.BUTTON_PAN_UP, c.BUTTON_PAN_DOWN
masks.rotate_left, masks.rotate_right, masks.reset =
    c.BUTTON_ROTATE_LEFT, c.BUTTON_ROTATE_RIGHT, c.BUTTON_RESET
local held, down, up, clock, randomState = 0, 0, 0, 0, c.DEFAULT_RANDOM_SEED
masks.pointer_left, masks.pointer_right, masks.pointer_hover =
    c.BUTTON_POINTER_LEFT, c.BUTTON_POINTER_RIGHT, c.BUTTON_POINTER_HOVER
masks.wheel_up, masks.wheel_down = c.BUTTON_WHEEL_UP, c.BUTTON_WHEEL_DOWN
masks.inventory, masks.character, masks.skills =
    c.BUTTON_INVENTORY, c.BUTTON_CHARACTER, c.BUTTON_SKILLS
masks.quest, masks.map = c.BUTTON_QUEST, c.BUTTON_MAP
masks.potion_1, masks.potion_2, masks.potion_3, masks.potion_4 =
    c.BUTTON_POTION_1, c.BUTTON_POTION_2, c.BUTTON_POTION_3, c.BUTTON_POTION_4
masks.shift, masks.escape = c.BUTTON_SHIFT, c.BUTTON_ESCAPE
local width, height = 640, 360
local pointerActive, pointerX, pointerY = false, 0, 0
local pointerHover = false
local phase = "load"
local function integer(value: number, lo: number, hi: number): number
    assert(
        value == math.floor(value) and value >= lo and value <= hi,
        "integer outside supported range"
    )
    return value
end
local function keyMask(key: Button): number
    return masks[key]
end
function api.display(w: number, h: number)
    assert((w == 640 and h == 360) or (w == 320 and h == 180), "unsupported display mode")
    width, height = w, h
    host.display(w, h)
end
function api.size(): (number, number)
    return width, height
end
function api.rgb(r: number, g: number, b: number): number
    return c.COLOR_OPAQUE_BLACK
        + integer(b, 0, c.COLOR_CHANNEL_MAX) * c.COLOR_BLUE_SCALE
        + integer(g, 0, c.COLOR_CHANNEL_MAX) * c.COLOR_GREEN_SCALE
        + integer(r, 0, c.COLOR_CHANNEL_MAX)
end
function api.clear(color: number)
    integer(color, c.COLOR_OPAQUE_BLACK, c.U32_MAX)
    if resources._in_pass() then
        resources.gfx.clear(resources.gfx.current_pass(), color)
    else
        host.clear(
            bit32.band(color, 255),
            bit32.band(bit32.rshift(color, 8), 255),
            bit32.band(bit32.rshift(color, 16), 255)
        )
    end
end
function api.rect(x: number, y: number, w: number, h: number, color: number)
    integer(color, c.COLOR_OPAQUE_BLACK, c.U32_MAX)
    if resources._in_pass() then
        resources.gfx.rect(resources.gfx.current_pass(), x, y, w, h, color)
    else
        host.rect(x, y, w, h, color)
    end
end
function api.sprite(id: number, x: number, y: number, scale: number?)
    integer(id, 0, 255)
    local s = integer(scale or 1, 1, 8)
    if resources._in_pass() then
        resources.gfx.sprite(resources.gfx.current_pass(), id, x, y, 16 * s, 16 * s)
    else
        host.draw_sprite(id, x, y, s)
    end
end
function api.sprite_size(id: number, x: number, y: number, w: number, h: number)
    integer(id, 0, 255)
    integer(w, 1, 128)
    integer(h, 1, 128)
    if resources._in_pass() then
        resources.gfx.sprite(resources.gfx.current_pass(), id, x, y, w, h)
    else
        host.draw_sprite_size(id, x, y, w, h)
    end
end
function api.text(value: string, x: number, y: number, color: number)
    assert(#value <= c.MAX_TEXT_BYTES_PER_COMMAND, "text command exceeds 1024 bytes")
    for i = 1, #value do
        assert(string.byte(value, i) < 128, "text must be ASCII")
    end
    integer(color, c.COLOR_OPAQUE_BLACK, c.U32_MAX)
    if resources._in_pass() then
        resources.gfx.text(resources.gfx.current_pass(), value, x, y, color)
    else
        host.draw_text(value, x, y, color)
    end
end
function api.assets(source: string | buffer | number)
    assert(phase == "load" or phase == "init", "graphics assets are immutable after init")
    if type(source) == "number" then
        local size = api.content.size(source)
        assert(size > 0, "graphics content " .. tostring(source) .. " is missing or empty")
        assert(size <= c.MAX_GRAPHICS_BYTES, "graphics assets too large")
        local bytes = buffer.create(size)
        assert(
            api.content.read(source, 0, bytes),
            "graphics content " .. tostring(source) .. " is unreadable"
        )
        host.graphics_assets(bytes)
    else
        host.graphics_assets(source)
    end
end
function api.buttons(): number
    return bit32.band(held, c.LEGACY_BUTTON_MASK)
end
function api.all_buttons(): number
    return held
end
function api.button(key: Button): boolean
    return bit32.band(held, keyMask(key)) ~= 0
end
function api.pressed(key: Button): boolean
    return bit32.band(down, keyMask(key)) ~= 0
end
function api.released(key: Button): boolean
    return bit32.band(up, keyMask(key)) ~= 0
end
function api.pointer(): (boolean, number, number)
    return pointerActive,
        if pointerActive then pointerX else 0,
        if pointerActive then pointerY else 0
end
function api.pointer_position(): (boolean, number, number)
    return pointerHover, pointerX, pointerY
end
function api.wheel(): number
    return (if api.button("wheel_up") then 1 else 0) - (if api.button("wheel_down") then 1 else 0)
end
function api.ticks(): number
    return clock
end
function api.sound()
    host.sound()
end
function api.seed(value: number)
    integer(value, 0, c.U32_MAX)
    randomState = if value == 0 then c.RANDOM_ZERO_SEED_FALLBACK else value
end
function api.random_u32(): number
    randomState = bit32.bxor(randomState, bit32.lshift(randomState, 13))
    randomState = bit32.bxor(randomState, bit32.rshift(randomState, 17))
    randomState = bit32.bxor(randomState, bit32.lshift(randomState, 5))
    return randomState
end
function api.debug_position(x: number, y: number)
    host.debug_position(x, y)
end
function api._wrap(game: Game, initialWidth: number?, initialHeight: number?): Game
    assert(
        type(game.init) == "function"
            and type(game.update) == "function"
            and type(game.draw) == "function",
        "missing game callback"
    )
    return {
        init = function()
            held, down, up, clock, randomState = 0, 0, 0, 0, c.DEFAULT_RANDOM_SEED
            pointerActive, pointerX, pointerY = false, 0, 0
            pointerHover = false
            width, height = initialWidth or 640, initialHeight or 360
            host.display(width, height)
            resources._begin(0)
            phase = "init"
            game.init()
            phase = "ready"
            resources._end()
        end,
        update = function(dt: number)
            local nextHeld = bit32.band(host.buttons(), c.INPUT_BUTTON_MASK)
            down, up =
                bit32.band(nextHeld, bit32.bnot(held)), bit32.band(held, bit32.bnot(nextHeld))
            held = nextHeld
            clock = (clock + 1) % c.U32_MODULUS
            local active, x, y = host.pointer()
            local inBounds = x >= 0 and y >= 0 and x < width and y < height
            pointerActive = active and inBounds
            pointerHover = (active or api.button("pointer_hover")) and inBounds
            pointerX, pointerY = if pointerHover then x else 0, if pointerHover then y else 0
            resources._begin(clock)
            phase = "update"
            game.update(dt)
            phase = "ready"
            resources._end()
        end,
        draw = function()
            resources._begin_draw()
            phase = "draw"
            game.draw()
            phase = "ready"
            resources._end()
        end,
    }
end
return api
