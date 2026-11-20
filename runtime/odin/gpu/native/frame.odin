package gpu

import r "../../resources"
import gl "vendor:OpenGL"
import sdl "vendor:sdl3"

GPU_Frame :: struct {
    version:               u64,
    fbo:                   u32,
    textures:              [2]u32,
    hud, mask:             u32,
    width, height, border: int,
    has_hud:               bool,
}

close_frames :: proc() {
    for &frame in device.frames {
        gl.DeleteTextures(2, &frame.textures[0])
        gl.DeleteTextures(1, &frame.hud)
        gl.DeleteTextures(1, &frame.mask)
        gl.DeleteFramebuffers(1, &frame.fbo)
    }
}

frame :: proc(job: r.Frame_Job) -> bool {
    if job.action == .Invalidate {
        for &entry in device.frames { entry.version = 0 }
        device.pending = false
        return true
    }
    candidate := &device.frames[1 - device.committed_frame]
    if job.action == .Publish {
        if job.version == 0 || candidate.version != job.version { return false }
        device.committed_frame = 1 - device.committed_frame
        device.pending = false
        device.published_frames += 1
        return true
    }
    if !sdl.GL_MakeCurrent(device.window, device.gl_context) { return false }
    border := 1 if len(job.preview) != 0 else 0
    rw, rh := job.width + 2 * border, job.height + 2 * border
    if job.action == .Stage {
        candidate.version = 0
        if !device.pending || device.width != rw || device.height != rh { return false }
        if candidate.fbo == 0 {
            gl.GenFramebuffers(1, &candidate.fbo)
            gl.GenTextures(2, &candidate.textures[0])
            gl.GenTextures(1, &candidate.hud)
            gl.GenTextures(1, &candidate.mask)
            for texture in candidate.textures { setup_texture(texture) }
            setup_texture(candidate.hud)
            setup_texture(candidate.mask)
        }
        if !target(candidate.fbo, candidate.textures[:], rw, rh) { return false }
        gl.BindVertexArray(device.vao)
        gl.Disable(gl.SCISSOR_TEST)
        gl.Disable(gl.DEPTH_TEST)
        quad(
            device.resolve,
            device.high_textures[0],
            device.high_textures[1],
            device.factor,
            rw,
            rh,
        )
        candidate.has_hud = len(job.mask) != 0
        if candidate.has_hud {
            gl.ActiveTexture(gl.TEXTURE0)
            allocate(candidate.hud, job.width, job.height, data = raw_data(job.color))
            allocate(candidate.mask, job.width, job.height, data = raw_data(job.mask), mask = true)
            device.presentation_upload_bytes += u64(job.width * job.height * 5)
        }
        if gl.GetError() != gl.NO_ERROR { return false }
        candidate.width, candidate.height, candidate.border = job.width, job.height, border
        candidate.version = job.version
        return true
    }
    published := &device.frames[device.committed_frame]
    if job.action != .Read ||
       job.version == 0 ||
       published.version != job.version ||
       published.width != job.width ||
       published.height != job.height ||
       published.border != border {
        return false
    }
    color := make([]u8, rw * rh * 4)
    depth := make([]u8, len(color))
    defer delete(color)
    defer delete(depth)
    gl.BindFramebuffer(gl.READ_FRAMEBUFFER, published.fbo)
    gl.ReadBuffer(gl.COLOR_ATTACHMENT0)
    gl.ReadPixels(0, 0, i32(rw), i32(rh), gl.RGBA, gl.UNSIGNED_BYTE, raw_data(color))
    gl.ReadBuffer(gl.COLOR_ATTACHMENT1)
    gl.ReadPixels(0, 0, i32(rw), i32(rh), gl.RGBA, gl.UNSIGNED_BYTE, raw_data(depth))
    device.snapshot_readback_bytes += u64(rw * rh * 8)
    device.attachment_readback_bytes += u64(rw * rh * 8)
    if gl.GetError() != gl.NO_ERROR { return false }
    r.copy_raster_output(
        job.color,
        job.depth,
        job.preview,
        job.mask,
        color,
        depth,
        job.width,
        job.height,
        border,
    )
    return true
}

frame_statistics :: proc() -> [5]u64 {
    bytes: u64
    for entry in device.frames {
        for texture in ([4]u32{entry.textures[0], entry.textures[1], entry.hud, entry.mask}) {
            shape := device.texture_storage[texture]
            bytes += u64(shape[0] * shape[1] * (1 if shape[2] == 2 else 4))
        }
    }
    return {
        device.published_frames,
        device.direct_presents,
        device.snapshot_readback_bytes,
        device.presentation_upload_bytes,
        bytes,
    }
}
