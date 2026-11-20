package gpu

import resources "../../resources"
import gl "vendor:OpenGL"
import sdl "vendor:sdl3"

Device :: struct {
    frames:                    [2]GPU_Frame,
    committed_frame:           int,
    published_frames:          u64,
    direct_presents:           u64,
    snapshot_readback_bytes:   u64,
    presentation_upload_bytes: u64,
    pending:                   bool,
    attachment_upload_bytes:   u64,
    attachment_readback_bytes: u64,
    attachment_batches:        u64,
    attachment_sequences:      u64,
    material_cache:            map[u64]Cached_Texture,
    material_cache_bytes:      int,
    texture_uploads:           u64,
    texture_cache_hits:        u64,
    texture_upload_bytes:      u64,
    surface_samples:           bool,
    present_program:           u32,
    present_fbo:               u32,
    present_texture:           u32,
    hud_texture:               u32,
    present_width:             int,
    present_height:            int,
    resident:                  u32,
    resident_vao:              u32,
    cache:                     map[u64]Cached_Mesh,
    cache_bytes:               int,
    mesh_uploads:              u64,
    cache_hits:                u64,
    upload_bytes:              u64,
    window:                    ^sdl.Window,
    gl_context:                sdl.GLContext,
    initialize:                u32,
    mesh:                      u32,
    resolve:                   u32,
    vao:                       u32,
    vertices:                  u32,
    input:                     [2]u32,
    present_input:             [2]u32,
    high:                      u32,
    low:                       u32,
    high_textures:             [3]u32,
    low_textures:              [2]u32,
    width:                     int,
    height:                    int,
    factor:                    int,
    quality:                   int,
    color:                     []u8,
    depth:                     []u8,
    texture_storage:           map[u32][3]int,
}
device: Device

open :: proc(quality: int, surface_samples := false) -> bool {
    device.quality = quality
    device.surface_samples = surface_samples
    if !sdl.InitSubSystem({.VIDEO}) { return false }
    _ = sdl.GL_SetAttribute(.CONTEXT_MAJOR_VERSION, 3)
    _ = sdl.GL_SetAttribute(.CONTEXT_MINOR_VERSION, 3)
    _ = sdl.GL_SetAttribute(.CONTEXT_PROFILE_MASK, transmute(i32)sdl.GLProfile{.CORE})
    when ODIN_OS == .Darwin {
        _ = sdl.GL_SetAttribute(
            .CONTEXT_FLAGS,
            transmute(i32)sdl.GLContextFlag{.FORWARD_COMPATIBLE},
        )
    }
    device.window = sdl.CreateWindow("GPU execution device", 1, 1, {.OPENGL, .HIDDEN, .RESIZABLE})
    if device.window == nil { return false }
    device.gl_context = sdl.GL_CreateContext(device.window)
    if device.gl_context == nil {
        close()
        return false
    }
    gl.load_up_to(3, 3, proc(pointer: rawptr, name: cstring) {
        (cast(^rawptr)pointer)^ = rawptr(sdl.GL_GetProcAddress(name))
    })
    prefix :: "#version 330 core\n"
    ok: bool
    device.initialize, ok = gl.load_shaders_source(
        prefix + #load("../fullscreen.vert"),
        prefix + #load("../initialize.frag"),
    )
    if !ok {
        close()
        return false
    }
    device.resident, ok = gl.load_shaders_source(
        prefix + #load("../resident.vert"),
        prefix + #load("../mesh.frag"),
    )
    if !ok { close(); return false }
    gl.GenVertexArrays(1, &device.resident_vao)
    device.present_program, ok = gl.load_shaders_source(
        prefix + #load("../fullscreen.vert"),
        prefix + #load("../present.frag"),
    )
    if !ok { close(); return false }
    gl.GenFramebuffers(1, &device.present_fbo)
    gl.GenTextures(1, &device.present_texture)
    gl.GenTextures(1, &device.hud_texture)
    setup_texture(device.present_texture)
    setup_texture(device.hud_texture)
    device.mesh, ok = gl.load_shaders_source(
        prefix + #load("../mesh.vert"),
        prefix + #load("../mesh.frag"),
    )
    if !ok {
        close()
        return false
    }
    device.resolve, ok = gl.load_shaders_source(
        prefix + #load("../fullscreen.vert"),
        prefix + #load("../resolve.frag"),
    )
    if !ok {
        close()
        return false
    }
    gl.GenVertexArrays(1, &device.vao)
    gl.BindVertexArray(device.vao)
    gl.GenBuffers(1, &device.vertices)
    gl.BindBuffer(gl.ARRAY_BUFFER, device.vertices)
    gl.EnableVertexAttribArray(0)
    gl.VertexAttribPointer(0, 4, gl.FLOAT, gl.FALSE, 28, 0)
    gl.EnableVertexAttribArray(1)
    gl.VertexAttribPointer(1, 3, gl.FLOAT, gl.FALSE, 28, 16)
    gl.GenTextures(2, &device.input[0])
    gl.GenTextures(2, &device.present_input[0])
    gl.GenTextures(3, &device.high_textures[0])
    gl.GenTextures(2, &device.low_textures[0])
    for texture in device.input { setup_texture(texture) }
    for texture in device.present_input { setup_texture(texture) }
    for texture in device.high_textures { setup_texture(texture) }
    for texture in device.low_textures { setup_texture(texture) }
    gl.GenFramebuffers(1, &device.high)
    gl.GenFramebuffers(1, &device.low)
    gl.Disable(gl.DITHER)
    return gl.GetError() == gl.NO_ERROR
}

close :: proc() {
    if device.gl_context != nil {
        _ = sdl.GL_MakeCurrent(device.window, device.gl_context)
        close_frames()
        clear_meshes()
        clear_textures()
        gl.DeleteProgram(device.present_program)
        gl.DeleteFramebuffers(1, &device.present_fbo)
        gl.DeleteTextures(1, &device.present_texture)
        gl.DeleteTextures(1, &device.hud_texture)
        if device.resident != 0 { gl.DeleteProgram(device.resident) }
        if device.resident_vao != 0 { gl.DeleteVertexArrays(1, &device.resident_vao) }
        if device.initialize != 0 { gl.DeleteProgram(device.initialize) }
        if device.mesh != 0 { gl.DeleteProgram(device.mesh) }
        if device.resolve != 0 { gl.DeleteProgram(device.resolve) }
        gl.DeleteBuffers(1, &device.vertices)
        gl.DeleteVertexArrays(1, &device.vao)
        gl.DeleteTextures(2, &device.input[0])
        gl.DeleteTextures(2, &device.present_input[0])
        gl.DeleteTextures(3, &device.high_textures[0])
        gl.DeleteTextures(2, &device.low_textures[0])
        gl.DeleteFramebuffers(1, &device.high)
        gl.DeleteFramebuffers(1, &device.low)
        _ = sdl.GL_DestroyContext(device.gl_context)
    }
    if device.window != nil { sdl.DestroyWindow(device.window) }
    delete(device.color)
    delete(device.depth)
    delete(device.texture_storage)
    device = {}
}

setup_texture :: proc(texture: u32) {
    gl.BindTexture(gl.TEXTURE_2D, texture)
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
}

allocate :: proc(
    texture: u32,
    width, height: int,
    depth := false,
    data: rawptr = nil,
    mask := false,
) {
    gl.BindTexture(gl.TEXTURE_2D, texture)
    if device.texture_storage == nil { device.texture_storage = make(map[u32][3]int) }
    key := [3]int{width, height, 2 if mask else 1 if depth else 0}
    format := u32(gl.RED if mask else gl.DEPTH_COMPONENT if depth else gl.RGBA)
    element := u32(gl.FLOAT if depth else gl.UNSIGNED_BYTE)
    if previous, exists := device.texture_storage[texture]; exists && previous == key {
        if data !=
           nil { gl.TexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, i32(width), i32(height), format, element, data) }
        return
    }
    gl.TexImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R8 if mask else gl.DEPTH_COMPONENT32F if depth else gl.RGBA8,
        i32(width),
        i32(height),
        0,
        format,
        element,
        data,
    )
    device.texture_storage[texture] = key
}

target :: proc(framebuffer: u32, textures: []u32, width, height: int) -> bool {
    gl.BindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    for texture, i in textures {
        allocate(texture, width, height, i == 2)
        attachment := gl.DEPTH_ATTACHMENT if i == 2 else gl.COLOR_ATTACHMENT0 + u32(i)
        gl.FramebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, texture, 0)
    }
    attachments := [2]u32{gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1}
    gl.DrawBuffers(2, &attachments[0])
    return gl.CheckFramebufferStatus(gl.FRAMEBUFFER) == gl.FRAMEBUFFER_COMPLETE
}

quad :: proc(program, color, depth: u32, factor, width, height: int, border := 0) {
    gl.UseProgram(program)
    gl.ActiveTexture(gl.TEXTURE0)
    gl.BindTexture(gl.TEXTURE_2D, color)
    gl.Uniform1i(gl.GetUniformLocation(program, "colorSource"), 0)
    gl.ActiveTexture(gl.TEXTURE1)
    gl.BindTexture(gl.TEXTURE_2D, depth)
    gl.Uniform1i(gl.GetUniformLocation(program, "depthSource"), 1)
    gl.Uniform1i(gl.GetUniformLocation(program, "factor"), i32(factor))
    gl.Uniform1i(gl.GetUniformLocation(program, "border"), i32(border))
    gl.Viewport(0, 0, i32(width), i32(height))
    gl.DrawArrays(gl.TRIANGLES, 0, 3)
}

raster :: proc(job: resources.Raster_Job) -> bool {
    succeeded := false
    defer { if !succeeded { device.pending = false } }
    if !sdl.GL_MakeCurrent(device.window, device.gl_context) { return false }
    w, h := job.width, job.height
    border := 1 if len(job.border) != 0 else 0
    rw, rh := w + border * 2, h + border * 2
    factor := 1
    if device.quality == 2 { factor = 2 }
    if device.quality == 6 { factor = max(1, min(6, 1920 / w, 1080 / h)) }
    factor = max(1, min(factor, 1920 / w, 1080 / h))
    if rw * rh * factor * factor > 1932 * 1092 { return false }
    if job.continuation &&
       (!device.pending ||
               device.width != rw ||
               device.height != rh ||
               device.factor != factor) { return false }
    device.pending = false
    if device.width != rw || device.height != rh || device.factor != factor {
        if !target(device.high, device.high_textures[:], rw * factor, rh * factor) ||
           !target(device.low, device.low_textures[:], rw, rh) { return false }
        delete(device.color)
        delete(device.depth)
        device.color = make([]u8, rw * rh * 4)
        device.depth = make([]u8, rw * rh * 4)
        device.width, device.height, device.factor = rw, rh, factor
    }
    gl.BindVertexArray(device.vao)
    gl.Disable(gl.SCISSOR_TEST)
    gl.BindFramebuffer(gl.FRAMEBUFFER, device.high)
    gl.Disable(gl.BLEND)
    gl.DepthMask(gl.TRUE)
    draw_buffers := [2]u32{gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1}
    gl.DrawBuffers(2, &draw_buffers[0])
    gl.Enable(gl.DEPTH_TEST)
    if !job.continuation {
        gl.DepthFunc(gl.ALWAYS)
        gl.ActiveTexture(gl.TEXTURE0)
        allocate(device.input[0], w, h, data = raw_data(job.color))
        allocate(device.input[1], w, h, data = raw_data(job.depth))
        device.attachment_upload_bytes += u64(w * h * 8)
        device.attachment_sequences += 1
        quad(
            device.initialize,
            device.input[0],
            device.input[1],
            factor,
            rw * factor,
            rh * factor,
            border,
        )
    }
    gl.DepthFunc(gl.LESS)
    gl.Viewport(0, 0, i32(rw * factor), i32(rh * factor))
    gl.Enable(gl.SCISSOR_TEST)
    x0, y0 := max(0, int(job.clip[0])), max(0, int(job.clip[1]))
    x1, y1 := min(w, int(job.clip[0] + job.clip[2])), min(h, int(job.clip[1] + job.clip[3]))
    if border !=
       0 { gl.Disable(gl.SCISSOR_TEST) } else { gl.Scissor(i32(x0 * factor), i32(y0 * factor), i32(max(0, x1 - x0) * factor), i32(max(0, y1 - y0) * factor)) }
    program := device.resident if len(job.draws) != 0 else device.mesh
    gl.UseProgram(program)
    gl.Uniform2f(gl.GetUniformLocation(program, "logicalSize"), f32(w), f32(h))
    gl.Uniform1i(gl.GetUniformLocation(program, "border"), i32(border))
    fog := job.fog_color
    gl.Uniform3f(
        gl.GetUniformLocation(program, "fogColor"),
        f32(fog & 255) / 255,
        f32((fog >> 8) & 255) / 255,
        f32((fog >> 16) & 255) / 255,
    )
    gl.Uniform2f(gl.GetUniformLocation(program, "fogRange"), job.fog_start, job.fog_end)
    if !bind_material(program, job.texture) { return false }
    if len(job.vertices) != 0 || len(job.draws) != 0 { device.attachment_batches += 1 }
    if len(job.draws) != 0 {
        for draw in job.draws { if !resident_draw(draw, w, h, border, job.texture) { return false } }
    } else {
        stride := resources.raster_stride(job.texture)
        gl.BindBuffer(gl.ARRAY_BUFFER, device.vertices)
        gl.BufferData(gl.ARRAY_BUFFER, len(job.vertices), raw_data(job.vertices), gl.STREAM_DRAW)
        gl.VertexAttribPointer(0, 4, gl.FLOAT, gl.FALSE, i32(stride), 0)
        gl.VertexAttribPointer(1, 3, gl.FLOAT, gl.FALSE, i32(stride), 16)
        if len(job.texture.pixels) != 0 {
            gl.EnableVertexAttribArray(2)
            gl.VertexAttribPointer(
                2,
                2,
                gl.FLOAT,
                gl.FALSE,
                i32(stride),
                resources.RASTER_VERTEX_BYTES,
            )
        } else { gl.DisableVertexAttribArray(2) }
        effect_draw(job.texture, 0, i32(len(job.vertices) / stride))
    }
    gl.Disable(gl.BLEND)
    gl.DepthMask(gl.TRUE)
    buffers := [2]u32{gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1}
    gl.DrawBuffers(2, &buffers[0])
    gl.Disable(gl.SCISSOR_TEST)
    gl.Disable(gl.DEPTH_TEST)
    if job.defer_readback {
        if gl.GetError() != gl.NO_ERROR { return false }
        device.pending = true
        succeeded = true
        return true
    }
    gl.BindFramebuffer(gl.FRAMEBUFFER, device.low)
    quad(device.resolve, device.high_textures[0], device.high_textures[1], factor, rw, rh)
    gl.ReadBuffer(gl.COLOR_ATTACHMENT0)
    gl.ReadPixels(0, 0, i32(rw), i32(rh), gl.RGBA, gl.UNSIGNED_BYTE, raw_data(device.color))
    gl.ReadBuffer(gl.COLOR_ATTACHMENT1)
    gl.ReadPixels(0, 0, i32(rw), i32(rh), gl.RGBA, gl.UNSIGNED_BYTE, raw_data(device.depth))
    device.attachment_readback_bytes += u64(rw * rh * 8)
    if gl.GetError() != gl.NO_ERROR { return false }
    resources.copy_raster_output(
        job.color,
        job.depth,
        job.border,
        job.mask,
        device.color,
        device.depth,
        w,
        h,
        border,
    )
    succeeded = true
    return true
}

// Transfer counters are cumulative; allocated texture bytes are storage, not
// transfers. Material and geometry caches have their own independent counters.
attachment_statistics :: proc() -> [4]u64 {
    return {
        device.attachment_upload_bytes,
        device.attachment_readback_bytes,
        device.attachment_batches,
        device.attachment_sequences,
    }
}

attachment_storage_bytes :: proc() -> u64 {
    bytes: u64
    for textures in ([3][]u32{device.input[:], device.high_textures[:], device.low_textures[:]}) {
        for texture in textures {
            shape := device.texture_storage[texture]
            bytes += u64(shape[0] * shape[1] * 4)
        }
    }
    return bytes
}
