--!strict
-- Editor declarations. The bundler replaces this module with the executor bridge.
local function unavailable(): never
    error("The Bytorio native bridge is provided by the player")
end
return {
    text_configure = function(_source: buffer): number
        return unavailable()
    end,
    text_read = function(_destination: buffer): number
        return unavailable()
    end,
    save_size = function(): number
        return unavailable()
    end,
    save_status = function(): number
        return unavailable()
    end,
    save_read = function(_destination: buffer): number
        return unavailable()
    end,
    save_write = function(_source: buffer): number
        return unavailable()
    end,
    content_size = function(_id: number): number
        return unavailable()
    end,
    content_read = function(_id: number, _offset: number, _destination: buffer): boolean
        return unavailable()
    end,
    profile = (function(): number
        return unavailable()
    end) :: (() -> number)?,
    resource_audio_status = function(): buffer
        return unavailable()
    end,
    resource_results = function(): {
        {
            id: number,
            format: number,
            width: number,
            height: number,
            bytes: buffer,
        }
    }
        return unavailable()
    end,
    resource_session = function(): number
        return unavailable()
    end,
    resource_emit = function(_op: number, _id: number, _args: buffer, _data: buffer)
        unavailable()
    end,
    display = function(_w: number, _h: number)
        unavailable()
    end,
    clear = function(_r: number, _g: number, _b: number)
        unavailable()
    end,
    rect = function(_x: number, _y: number, _w: number, _h: number, _color: number)
        unavailable()
    end,
    draw_sprite = function(_id: number, _x: number, _y: number, _scale: number)
        unavailable()
    end,
    draw_sprite_size = function(_id: number, _x: number, _y: number, _w: number, _h: number)
        unavailable()
    end,
    draw_text = function(_text: string, _x: number, _y: number, _color: number)
        unavailable()
    end,
    graphics_assets = function(_data: string | buffer)
        unavailable()
    end,
    buttons = function(): number
        return unavailable()
    end,
    pointer = function(): (boolean, number, number)
        unavailable()
        return false, 0, 0
    end,
    sound = function()
        unavailable()
    end,
    debug_position = function(_x: number, _y: number)
        unavailable()
    end,
}
