package gpu

import resources "../../resources"
import gl "vendor:OpenGL"

GPU_TEXTURE_CACHE_BYTES :: 32 * 1024 * 1024

effect_draw :: proc(view: resources.Texture_View, first, count: i32) {
    if !view.effect {
        gl.DrawArrays(gl.TRIANGLES, first, count)
        return
    }
    // Per-primitive depth publication preserves submission order, including
    // overlapping triangles inside one mesh. Packed depth is never blended.
    step := count if view.skip_depth_write else 3
    for at := first; at < first + count; at += step {
        buffers := [2]u32{gl.COLOR_ATTACHMENT0, gl.NONE}
        gl.DrawBuffers(2, &buffers[0])
        gl.Enable(gl.BLEND)
        gl.BlendFunc(gl.ONE, gl.ONE if view.additive else gl.ONE_MINUS_SRC_ALPHA)
        gl.DepthMask(gl.FALSE)
        gl.DepthFunc(gl.ALWAYS if view.skip_depth_test else gl.LESS)
        gl.DrawArrays(gl.TRIANGLES, at, step)
        if !view.skip_depth_write {
            buffers = {gl.NONE, gl.COLOR_ATTACHMENT1}
            gl.DrawBuffers(2, &buffers[0])
            gl.Disable(gl.BLEND)
            gl.DepthMask(gl.TRUE)
            gl.DrawArrays(gl.TRIANGLES, at, step)
        }
    }
}

Cached_Texture :: struct {
    texture: u32,
    bytes:   int,
}

clear_textures :: proc() {
    for _, entry in device.material_cache {
        texture := entry.texture
        gl.DeleteTextures(1, &texture)
        delete_key(&device.texture_storage, texture)
    }
    delete(device.material_cache)
    device.material_cache = nil
    device.material_cache_bytes = 0
}

bind_material :: proc(program: u32, view: resources.Texture_View) -> bool {
    textured := len(view.pixels) != 0
    gl.Uniform1i(gl.GetUniformLocation(program, "useTexture"), 1 if textured else 0)
    gl.Uniform1i(gl.GetUniformLocation(program, "materialTexture"), 2)
    gl.Uniform1i(gl.GetUniformLocation(program, "alphaCutout"), 1 if view.cutout else 0)
    gl.Uniform1i(gl.GetUniformLocation(program, "alphaCutoff"), i32(view.alpha_cutoff))
    gl.Uniform1i(gl.GetUniformLocation(program, "effectMaterial"), i32(view.effect))
    gl.Uniform1i(gl.GetUniformLocation(program, "additiveMaterial"), i32(view.additive))
    gl.ActiveTexture(gl.TEXTURE2)
    if !textured {
        gl.BindTexture(gl.TEXTURE_2D, device.input[0])
        return true
    }
    entry, exists := device.material_cache[view.version]
    if exists {
        device.texture_cache_hits += 1
    } else {
        size := len(view.pixels)
        if view.version == 0 || size > GPU_TEXTURE_CACHE_BYTES { return false }
        if device.material_cache_bytes + size > GPU_TEXTURE_CACHE_BYTES ||
           len(device.material_cache) >= GPU_CACHE_ENTRIES { clear_textures() }
        texture: u32
        gl.GenTextures(1, &texture)
        setup_texture(texture)
        allocate(texture, int(view.width), int(view.height), data = raw_data(view.pixels))
        if gl.GetError() != gl.NO_ERROR {
            gl.DeleteTextures(1, &texture)
            delete_key(&device.texture_storage, texture)
            return false
        }
        entry = {texture, size}
        if device.material_cache == nil { device.material_cache = make(map[u64]Cached_Texture) }
        device.material_cache[view.version] = entry
        device.material_cache_bytes += size
        device.texture_uploads += 1
        device.texture_upload_bytes += u64(size)
    }
    gl.BindTexture(gl.TEXTURE_2D, entry.texture)
    gl.Uniform2i(
        gl.GetUniformLocation(program, "textureAddress"),
        i32(view.address_u),
        i32(view.address_v),
    )
    return true
}

texture_statistics :: proc() -> [3]u64 {
    return {device.texture_uploads, device.texture_cache_hits, device.texture_upload_bytes}
}

texture_cached_bytes :: proc() -> int { return device.material_cache_bytes }
