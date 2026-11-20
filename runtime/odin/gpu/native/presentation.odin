package gpu

import resources "../../resources"
import "core:math"
import gl "vendor:OpenGL"
import sdl "vendor:sdl3"

show :: proc(title: cstring, width, height: int, vsync := true) -> ^sdl.Window {
    if !sdl.SetWindowTitle(device.window, title) ||
       !sdl.SetWindowSize(device.window, i32(width), i32(height)) ||
       !sdl.ShowWindow(device.window) { return nil }
    _ = sdl.GL_SetSwapInterval(1 if vsync else 0)
    return device.window
}

// GPU-only expansion/composition. Logical readbacks remain untouched. The FBO
// keeps row zero at the top for diagnostics; the window blit flips it for GL.
present :: proc(
    r: ^resources.Registry,
    pixels: []u32,
    width, height, available_width, available_height: int,
    window := false,
) -> bool {
    if !sdl.GL_MakeCurrent(device.window, device.gl_context) { return false }
    snapshot := &device.frames[device.committed_frame]
    direct := r.gpu_frame.job.version != 0
    if direct &&
       (snapshot.version != r.gpu_frame.job.version ||
               snapshot.width != width ||
               snapshot.height != height) { return false }
    scale :=
        max(1, min(6, 1920 / width, 1080 / height, available_width / width, available_height / height)) if r.preview_enabled else 1
    smooth := r.preview_enabled && scale > 1
    out_width, out_height := width * scale, height * scale
    if device.present_width != out_width || device.present_height != out_height {
        allocate(device.present_texture, out_width, out_height)
        gl.BindFramebuffer(gl.FRAMEBUFFER, device.present_fbo)
        gl.FramebufferTexture2D(
            gl.FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D,
            device.present_texture,
            0,
        )
        attachment := u32(gl.COLOR_ATTACHMENT0)
        gl.DrawBuffers(1, &attachment)
        if gl.CheckFramebufferStatus(gl.FRAMEBUFFER) != gl.FRAMEBUFFER_COMPLETE { return false }
        device.present_width, device.present_height = out_width, out_height
    }
    gl.BindVertexArray(device.vao)
    gl.BindFramebuffer(gl.FRAMEBUFFER, device.present_fbo)
    gl.Disable(gl.DEPTH_TEST)
    gl.Disable(gl.SCISSOR_TEST)
    program := device.present_program
    gl.UseProgram(program)
    gl.ActiveTexture(gl.TEXTURE0)
    if direct {
        gl.BindTexture(gl.TEXTURE_2D, snapshot.textures[0])
        device.direct_presents += 1
    } else if smooth {
        allocate(device.present_input[0], width + 2, height + 2, data = raw_data(r.preview))
    } else {
        allocate(device.present_input[0], width, height, data = raw_data(pixels))
    }
    gl.Uniform1i(gl.GetUniformLocation(program, "colorSource"), 0)
    // All samplers must point at initialized inputs, never the attached output.
    for unit in 1 ..< 3 {
        gl.ActiveTexture(gl.TEXTURE0 + u32(unit))
        gl.BindTexture(gl.TEXTURE_2D, snapshot.textures[0] if direct else device.present_input[0])
    }
    gl.Uniform1i(gl.GetUniformLocation(program, "depthSource"), 1)
    gl.Uniform1i(gl.GetUniformLocation(program, "hudSource"), 2)
    if direct && snapshot.has_hud {
        gl.ActiveTexture(gl.TEXTURE1)
        gl.BindTexture(gl.TEXTURE_2D, snapshot.hud)
        gl.ActiveTexture(gl.TEXTURE2)
        gl.BindTexture(gl.TEXTURE_2D, snapshot.mask)
    } else if !direct && smooth {
        gl.ActiveTexture(gl.TEXTURE1)
        allocate(device.present_input[1], width, height, data = raw_data(pixels))
        gl.Uniform1i(gl.GetUniformLocation(program, "depthSource"), 1)
        gl.ActiveTexture(gl.TEXTURE2)
        allocate(device.hud_texture, width, height, data = raw_data(r.preview_mask), mask = true)
        gl.Uniform1i(gl.GetUniformLocation(program, "hudSource"), 2)
    }
    gl.Uniform2i(gl.GetUniformLocation(program, "logicalSize"), i32(width), i32(height))
    gl.Uniform2f(
        gl.GetUniformLocation(program, "residual"),
        f32(math.round(r.preview_residual[0] * f64(scale)) / f64(scale)),
        f32(math.round(r.preview_residual[1] * f64(scale)) / f64(scale)),
    )
    gl.Uniform1i(gl.GetUniformLocation(program, "scale"), i32(scale))
    gl.Uniform1i(gl.GetUniformLocation(program, "useSmooth"), i32(smooth))
    gl.Uniform1i(
        gl.GetUniformLocation(program, "useHud"),
        i32(snapshot.has_hud if direct else smooth),
    )
    gl.Uniform1i(
        gl.GetUniformLocation(program, "sourceBorder"),
        i32(snapshot.border) if direct else i32(smooth),
    )
    gl.Uniform1i(gl.GetUniformLocation(program, "flipY"), 0)
    gl.Uniform1i(gl.GetUniformLocation(program, "outputHeight"), i32(out_height))
    background := r.preview_background
    gl.Uniform4f(
        gl.GetUniformLocation(program, "background"),
        f32(background & 255) / 255,
        f32((background >> 8) & 255) / 255,
        f32((background >> 16) & 255) / 255,
        f32(background >> 24) / 255,
    )
    gl.Viewport(0, 0, i32(out_width), i32(out_height))
    gl.DrawArrays(gl.TRIANGLES, 0, 3)
    if gl.GetError() != gl.NO_ERROR { return false }
    if window {
        gl.BindFramebuffer(gl.DRAW_FRAMEBUFFER, 0)
        gl.ClearColor(0, 0, 0, 1)
        gl.Clear(gl.COLOR_BUFFER_BIT)
        fit := min(f64(available_width) / f64(width), f64(available_height) / f64(height))
        if fit >= 1 { fit = math.floor(fit) }
        w, h := int(f64(width) * fit), int(f64(height) * fit)
        x, y := (available_width - w) / 2, (available_height - h) / 2
        gl.BindFramebuffer(gl.READ_FRAMEBUFFER, device.present_fbo)
        gl.ReadBuffer(gl.COLOR_ATTACHMENT0)
        gl.BlitFramebuffer(
            0,
            i32(out_height),
            i32(out_width),
            0,
            i32(x),
            i32(y),
            i32(x + w),
            i32(y + h),
            gl.COLOR_BUFFER_BIT,
            gl.NEAREST,
        )
        return sdl.GL_SwapWindow(device.window)
    }
    // Benchmark completion includes GPU execution without a presentation readback.
    gl.Finish()
    return gl.GetError() == gl.NO_ERROR
}

statistics :: proc() -> [3]u64 {
    return {device.mesh_uploads, device.cache_hits, device.upload_bytes}
}

cached_bytes :: proc() -> int {
    return device.cache_bytes
}

// Explicit diagnostic readback; the player and timing path never call this.
capture_presentation :: proc() -> []u8 {
    bytes := make([]u8, device.present_width * device.present_height * 4)
    gl.BindFramebuffer(gl.READ_FRAMEBUFFER, device.present_fbo)
    gl.ReadBuffer(gl.COLOR_ATTACHMENT0)
    gl.ReadPixels(
        0,
        0,
        i32(device.present_width),
        i32(device.present_height),
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        raw_data(bytes),
    )
    return bytes
}
