package main

import gpu "../../../runtime/odin/gpu/native"
import w "../../../runtime/odin/resource_protocol"
import r "../../../runtime/odin/resources"
import "core:fmt"
import "core:os"

main :: proc() {
    if !gpu.open(1) { fmt.eprintln("GPU initialization failed"); os.exit(1) }
    defer gpu.close()
    color := make([]u8, 32 * 32 * 4)
    depth := make([]u8, len(color))
    defer delete(color)
    defer delete(depth)
    for at := 0; at < len(depth); at += 4 { r.putf(depth, at, 1) }
    vertices := [21]f32 {
        -0.8,
        -0.8,
        0.25,
        1,
        255,
        0,
        0,
        0,
        0.8,
        0.25,
        1,
        255,
        0,
        0,
        0.8,
        -0.8,
        0.25,
        1,
        255,
        0,
        0,
    }
    bytes := (cast([^]u8)&vertices[0])[:size_of(vertices)]
    job := r.Raster_Job {
        vertices  = bytes,
        color     = color,
        depth     = depth,
        width     = 32,
        height    = 32,
        clip      = {0, 0, 32, 32},
        fog_color = 0xff000000,
        fog_start = 1,
        fog_end   = 2,
    }
    if !gpu.raster(job) { fmt.eprintln("GPU raster failed"); os.exit(1) }
    pixel := r.u32le(color, (16 * 32 + 16) * 4)
    z := r.f32le(depth, (16 * 32 + 16) * 4)
    fmt.printf("{{\"pixel\":%d,\"depth\":%.6f}}\n", pixel, z)
    if pixel != 0xff0000ff || z < 0.24999 || z > 0.25001 { os.exit(1) }
    mesh := make([]u8, 3 * 16 + 3 * 4)
    defer delete(mesh)
    for i in 0 ..< 3 {
        for axis in 0 ..< 3 { r.putf(mesh, i * 16 + axis * 4, f64(vertices[i * 7 + axis])) }
        r.put32(mesh, i * 16 + 12, 0xff0000ff)
        r.put32(mesh, 48 + i * 4, u32(i))
    }
    identity := [16]f32{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1}
    draw := r.Resident_Draw {
        version      = 1,
        data         = mesh,
        vertex_count = 3,
        index_count  = 3,
        model        = identity,
        view         = identity,
        ambient      = 1,
    }
    job.vertices = nil
    job.draws = []r.Resident_Draw{draw}
    for _ in 0 ..< 2 {
        for &value in color { value = 0 }
        for at := 0; at < len(depth); at += 4 { r.putf(depth, at, 1) }
        if !gpu.raster(job) ||
           r.u32le(color, (16 * 32 + 16) * 4) != 0xff0000ff ||
           r.f32le(depth, (16 * 32 + 16) * 4) != 0.25 { os.exit(1) }
    }
    counts := gpu.statistics()
    if counts != ([3]u64{1, 1, 144}) { os.exit(1) }
    job.draws[0].ambient = 0
    job.draws[0].light = {0, 0, -0.5}
    for at := 0; at < len(depth); at += 4 { r.putf(depth, at, 1) }
    if !gpu.raster(job) || r.u32le(color, (16 * 32 + 16) * 4) != 0xff000080 { os.exit(1) }
    palette := make([]u8, 1024)
    defer delete(palette)
    for i in 0 ..< 3 { r.put32(mesh, i * 16 + 12, 1) }
    job.draws[0].version = 2
    job.draws[0].palette = palette
    job.draws[0].ambient = 1
    for expected in ([2]u32{0xff00ff00, 0xffff0000}) {
        r.put32(palette, 4, expected)
        for at := 0; at < len(depth); at += 4 { r.putf(depth, at, 1) }
        if !gpu.raster(job) || r.u32le(color, (16 * 32 + 16) * 4) != expected { os.exit(1) }
    }
    if gpu.statistics()[0] != 3 { os.exit(1) }

    // Independent presentation orientation, residual and HUD expectations.
    registry: r.Registry
    registry.preview_enabled = true
    registry.preview = make([]u8, 322 * 182 * 4)
    registry.preview_mask = make([]u8, 320 * 180)
    defer delete(registry.preview)
    defer delete(registry.preview_mask)
    registry.preview_background = 0xff000000
    registry.preview_residual[0] = 1.0 / 6.0
    for y in 0 ..< 182 {
        for x in 0 ..< 322 { r.put32(registry.preview, (y * 322 + x) * 4, 0xff000000 | u32(x % 256) | u32(y % 256) << 8) }
    }
    output := make([]u32, 320 * 180)
    defer delete(output)
    registry.preview_mask[90 * 320 + 160] = 1
    output[90 * 320 + 160] = 0xffff00ff
    if !gpu.present(&registry, output, 320, 180, 1920, 1080) { os.exit(1) }
    capture := gpu.capture_presentation()
    defer delete(capture)
    if r.u32le(capture, (100 * 1920 + 101) * 4) != 0xff001112 ||
       r.u32le(capture, (540 * 1920 + 960) * 4) != 0xffff00ff { os.exit(1) }
    gpu.close()
    verify_surface_samples()
    verify_textured_meshes()
    verify_cutout_depth()
    verify_effect_blending()
    verify_attachment_sequences()
    verify_committed_frames()
}

verify_committed_frames :: proc() {
    for quality in ([3]int{1, 2, 6}) {
        if !gpu.open(quality) { os.exit(1) }
        color, depth: [32 * 32 * 4]u8
        mask: [32 * 32]u8
        for at := 0; at < len(depth); at += 4 { r.putf(depth[:], at, 1) }
        vertices := [21]f32 {
            -0.8,
            -0.8,
            0.25,
            1,
            255,
            0,
            0,
            0,
            0.8,
            0.25,
            1,
            255,
            0,
            0,
            0.8,
            -0.8,
            0.25,
            1,
            255,
            0,
            0,
        }
        job := r.Raster_Job {
            vertices       = (cast([^]u8)&vertices[0])[:size_of(vertices)],
            color          = color[:],
            depth          = depth[:],
            width          = 32,
            height         = 32,
            clip           = {0, 0, 32, 32},
            fog_start      = 1,
            fog_end        = 2,
            defer_readback = true,
        }
        if !gpu.raster(job) { os.exit(1) }
        center := 16 * 32 + 16
        mask[center] = 1
        r.put32(color[:], center * 4, 0xff00ff00)
        frame := r.Frame_Job {
            action  = .Stage,
            version = 101,
            color   = color[:],
            depth   = depth[:],
            mask    = mask[:],
            width   = 32,
            height  = 32,
        }
        if !gpu.frame(frame) { os.exit(1) }
        frame.action = .Publish
        if !gpu.frame(frame) || gpu.attachment_statistics()[1] != 0 { os.exit(1) }
        registry: r.Registry
        registry.preview_background = 0xff000000
        registry.gpu_frame.job = frame
        output: [32 * 32]u32
        // The presenter must use the committed GPU image even though this CPU
        // output is empty. Repeated presentation performs no additional uploads.
        for _ in 0 ..< 2 {
            if !gpu.present(&registry, output[:], 32, 32, 32, 32) { os.exit(1) }
            captured := gpu.capture_presentation()
            if r.u32le(captured, center * 4) != 0xff00ff00 ||
               r.u32le(captured, (18 * 32 + 16) * 4) != 0xff0000ff { os.exit(1) }
            delete(captured)
        }
        stats := gpu.frame_statistics()
        if stats[0] != 1 ||
           stats[1] != 2 ||
           stats[2] != 0 ||
           stats[3] != 32 * 32 * 5 ||
           stats[4] == 0 { os.exit(1) }
        // Private rendering/staging cannot change the displayed snapshot until
        // Publish. It must also not change what an explicit logical read sees.
        for i in 0 ..< 3 { vertices[i * 7 + 4], vertices[i * 7 + 6] = 0, 255 }
        if !gpu.raster(job) { os.exit(1) }
        candidate := frame
        candidate.action, candidate.version = .Stage, 102
        if !gpu.frame(candidate) ||
           !gpu.present(&registry, output[:], 32, 32, 32, 32) { os.exit(1) }
        captured := gpu.capture_presentation()
        if r.u32le(captured, (18 * 32 + 16) * 4) != 0xff0000ff { os.exit(1) }
        delete(captured)
        frame.action = .Read
        if !gpu.frame(frame) ||
           r.u32le(color[:], center * 4) != 0xff00ff00 ||
           r.u32le(color[:], (18 * 32 + 16) * 4) != 0xff0000ff ||
           r.f32le(depth[:], center * 4) != 0.25 { os.exit(1) }
        candidate.action = .Publish
        if !gpu.frame(candidate) || gpu.frame(frame) { os.exit(1) }
        if !gpu.frame({action = .Invalidate}) || gpu.frame(candidate) { os.exit(1) }
        gpu.close()
    }
}

verify_attachment_sequences :: proc() {
    for quality in ([3]int{1, 2, 6}) {
        if !gpu.open(quality) { os.exit(1) }
        color, depth: [32 * 32 * 4]u8
        for at := 0; at < len(depth); at += 4 { r.putf(depth[:], at, 1) }
        vertices := [21]f32 {
            -0.8,
            -0.8,
            0.25,
            1,
            255,
            0,
            0,
            0,
            0.8,
            0.25,
            1,
            255,
            0,
            0,
            0.8,
            -0.8,
            0.25,
            1,
            255,
            0,
            0,
        }
        job := r.Raster_Job {
            vertices       = (cast([^]u8)&vertices[0])[:size_of(vertices)],
            color          = color[:],
            depth          = depth[:],
            width          = 32,
            height         = 32,
            clip           = {0, 0, 32, 32},
            fog_start      = 1,
            fog_end        = 2,
            defer_readback = true,
        }
        if !gpu.raster(job) || r.u32le(color[:], (16 * 32 + 16) * 4) != 0 { os.exit(1) }
        // A farther blue triangle must load private depth, not CPU depth (1).
        for i in 0 ..< 3 {
            vertices[i * 7 + 2] = 0.75
            vertices[i * 7 + 4], vertices[i * 7 + 6] = 0, 255
        }
        job.continuation = true
        if !gpu.raster(job) { os.exit(1) }
        job.vertices = nil
        job.defer_readback = false
        if !gpu.raster(job) ||
           r.u32le(color[:], (16 * 32 + 16) * 4) != 0xff0000ff ||
           r.f32le(depth[:], (16 * 32 + 16) * 4) != 0.25 ||
           gpu.attachment_statistics() != ([4]u64{8192, 8192, 2, 1}) { os.exit(1) }
        // A consumed or mismatched continuation is rejected; a fresh job can
        // recover without accidentally reusing the previous transaction.
        if gpu.raster(job) { os.exit(1) }
        job.continuation, job.defer_readback = false, true
        if !gpu.raster(job) { os.exit(1) }
        job.continuation, job.width = true, 16
        if gpu.raster(job) { os.exit(1) }
        job.width = 32
        if gpu.raster(job) { os.exit(1) }
        job.continuation, job.defer_readback = false, false
        if !gpu.raster(job) { os.exit(1) }
        if gpu.attachment_storage_bytes() == 0 { os.exit(1) }
        gpu.close()
    }
}

verify_cutout_depth :: proc() {
    for quality in ([3]int{1, 2, 6}) {
        for resident in ([2]bool{false, true}) {
            if !gpu.open(quality) { os.exit(1) }
            color := make([]u8, 32 * 32 * 4)
            depth := make([]u8, len(color))
            stream: [6 * r.TEXTURED_RASTER_VERTEX_BYTES]u8
            far_stream: [6 * r.RASTER_VERTEX_BYTES]u8
            mesh: [4 * w.texturedVertexBytes + 6 * w.meshIndexBytes]u8
            pixels: [16]u8
            points := [4][2]f64{{-1, -1}, {1, -1}, {1, 1}, {-1, 1}}
            indices := [6]u32{0, 2, 1, 0, 3, 2}
            for point, i in points {
                for value, axis in point { r.putf(mesh[:], i * w.texturedVertexBytes + axis * 4, value) }
                r.putf(mesh[:], i * w.texturedVertexBytes + 8, 0.25)
                r.put32(mesh[:], i * w.texturedVertexBytes + w.meshColorOffset, 0xffffffff)
                r.putf(mesh[:], i * w.texturedVertexBytes + w.texturedUvOffset, (point[0] + 1) / 2)
                r.putf(
                    mesh[:],
                    i * w.texturedVertexBytes + w.texturedUvOffset + 4,
                    (1 - point[1]) / 2,
                )
            }
            for index, i in indices {
                r.put32(mesh[:], 4 * w.texturedVertexBytes + i * 4, index)
                for value, axis in points[index] {
                    r.putf(stream[:], i * r.TEXTURED_RASTER_VERTEX_BYTES + axis * 4, value)
                    r.putf(far_stream[:], i * r.RASTER_VERTEX_BYTES + axis * 4, value)
                }
                r.putf(stream[:], i * r.TEXTURED_RASTER_VERTEX_BYTES + 8, 0.25)
                r.putf(far_stream[:], i * r.RASTER_VERTEX_BYTES + 8, 0.75)
                r.putf(stream[:], i * r.TEXTURED_RASTER_VERTEX_BYTES + 12, 1)
                r.putf(far_stream[:], i * r.RASTER_VERTEX_BYTES + 12, 1)
                for channel in 0 ..< 3 { r.putf(stream[:], i * r.TEXTURED_RASTER_VERTEX_BYTES + 16 + channel * 4, 255) }
                r.putf(far_stream[:], i * r.RASTER_VERTEX_BYTES + 24, 255)
                for axis in 0 ..< 2 { r.putf(stream[:], i * r.TEXTURED_RASTER_VERTEX_BYTES + r.RASTER_VERTEX_BYTES + axis * 4, r.f32le(mesh[:], int(index) * w.texturedVertexBytes + w.texturedUvOffset + axis * 4)) }
            }
            for alpha, i in ([4]u8{0, 127, 128, 255}) { pixels[i * 4 + 1], pixels[i * 4 + 3] = alpha, alpha }
            identity := [16]f32{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1}
            draws := [1]r.Resident_Draw {
                {
                    textured     = true,
                    version      = 201,
                    data         = mesh[:],
                    vertex_count = 4,
                    index_count  = 6,
                    model        = identity,
                    view         = identity,
                    ambient      = 1,
                },
            }
            job := r.Raster_Job {
                texture = {
                    pixels  = pixels[:],
                    version = 101,
                    width   = 2,
                    height  = 2,
                    cutout  = true,
                },
                vertices = stream[:],
                color = color,
                depth = depth,
                width = 32,
                height = 32,
                clip = {0, 0, 32, 32},
                fog_start = 1,
                fog_end = 2,
            }
            if resident {
                job.vertices = nil
                job.draws = draws[:]
            }
            far_job := r.Raster_Job {
                vertices  = far_stream[:],
                color     = color,
                depth     = depth,
                width     = 32,
                height    = 32,
                clip      = {0, 0, 32, 32},
                fog_start = 1,
                fog_end   = 2,
            }
            expected := [5][4]u32 {
                {0xffff0000, 0xffff0000, 0xff00ff00, 0xff00ff00},
                {0xffff0000, 0xff00ff00, 0xff00ff00, 0xff00ff00},
                {0xff000000, 0xff00ff00, 0xff00ff00, 0xff00ff00},
                {0xffff0000, 0xffff0000, 0xffff0000, 0xff00ff00},
                {0xff000000, 0xff007f00, 0xff008000, 0xff00ff00},
            }
            for cutoff, scenario in ([5]u32{128, 127, 0, 255, 128}) {
                job.texture.alpha_cutoff = cutoff
                job.texture.cutout = scenario != 4
                for &value in color { value = 0 }
                for at := 0; at < len(depth); at += 4 { r.putf(depth, at, 1) }
                if !gpu.raster(job) || !gpu.raster(far_job) { os.exit(1) }
                for point, i in ([4][2]int{{8, 8}, {24, 8}, {8, 24}, {24, 24}}) {
                    at := (point[1] * 32 + point[0]) * 4
                    expected_depth :=
                        f64(0.75) if expected[scenario][i] == 0xffff0000 else f64(0.25)
                    if r.u32le(color, at) != expected[scenario][i] ||
                       r.f32le(depth, at) != expected_depth {
                        fmt.eprintln("Cutout GPU fixture failed", quality, resident, scenario, i)
                        os.exit(1)
                    }
                }
            }
            if gpu.texture_statistics() != ([3]u64{1, 4, 16}) { os.exit(1) }
            delete(color)
            delete(depth)
            gpu.close()
        }
    }
}

verify_textured_meshes :: proc() {
    for quality in ([3]int{1, 2, 6}) {
        for resident in ([2]bool{false, true}) {
            if !gpu.open(quality) { os.exit(1) }
            color := make([]u8, 32 * 32 * 4)
            depth := make([]u8, len(color))
            stream: [3 * r.TEXTURED_RASTER_VERTEX_BYTES]u8
            mesh: [3 * w.texturedVertexBytes + 3 * w.meshIndexBytes]u8
            texture: [16]u8
            points := [3][4]f64{{-1, -1, 0.5, 1}, {2, -2, 1, 2}, {0, 4, 2, 4}}
            for point, i in points {
                for value, axis in point { r.putf(stream[:], i * r.TEXTURED_RASTER_VERTEX_BYTES + axis * 4, value) }
                for axis in 0 ..< 3 { r.putf(stream[:], i * r.TEXTURED_RASTER_VERTEX_BYTES + 16 + axis * 4, 255) }
                for axis in 0 ..< 2 { r.putf(stream[:], i * r.TEXTURED_RASTER_VERTEX_BYTES + r.RASTER_VERTEX_BYTES + axis * 4, 1.2 if i == 2 && axis == 1 else 0) }
                for axis in 0 ..< 3 { r.putf(mesh[:], i * w.texturedVertexBytes + axis * 4, point[axis] * (2 if axis == 2 else 1)) }
                r.put32(mesh[:], i * w.texturedVertexBytes + w.meshColorOffset, 0xffffffff)
                r.putf(
                    mesh[:],
                    i * w.texturedVertexBytes + w.texturedUvOffset + 4,
                    1.2 if i == 2 else 0,
                )
                r.put32(mesh[:], 3 * w.texturedVertexBytes + i * w.meshIndexBytes, u32(i))
            }
            for value, i in ([4]u32{0xff0000ff, 0xff00ff00, 0xffff0000, 0xff0000ff}) { r.put32(texture[:], i * 4, value) }
            identity := [16]f32{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1}
            projection := identity
            projection[10], projection[11], projection[15] = 0.5, 1, 0
            draws := [1]r.Resident_Draw {
                {
                    textured     = true,
                    version      = 201,
                    data         = mesh[:],
                    vertex_count = 3,
                    index_count  = 3,
                    model        = identity,
                    view         = projection,
                    ambient      = 1,
                },
            }
            job := r.Raster_Job {
                texture = {
                    pixels    = texture[:],
                    version   = 101,
                    width     = 1,
                    height    = 4,
                    address_v = 1,
                },
                vertices = stream[:],
                color = color,
                depth = depth,
                width = 32,
                height = 32,
                clip = {0, 0, 32, 32},
                fog_start = 1,
                fog_end = 2,
            }
            if resident {
                job.vertices = nil
                job.draws = draws[:]
            }
            for frame in 0 ..< 3 {
                for &value in color { value = 0 }
                for at := 0; at < len(depth); at += 4 { r.putf(depth, at, 1) }
                if frame == 2 {
                    r.put32(texture[:], 4, 0xff000080)
                    job.texture.version = 102
                }
                expected := u32(0xff000080) if frame == 2 else u32(0xff00ff00)
                if !gpu.raster(job) || r.u32le(color, (16 * 32 + 16) * 4) != expected {
                    fmt.eprintln("Textured GPU fixture failed", quality, resident, frame)
                    os.exit(1)
                }
            }
            if gpu.texture_statistics() != ([3]u64{2, 1, 32}) { os.exit(1) }
            if resident && gpu.statistics() != ([3]u64{1, 2, 168}) { os.exit(1) }
            delete(color)
            delete(depth)
            gpu.close()
        }
    }
}

verify_surface_samples :: proc() {
    if !gpu.open(1, true) { os.exit(1) }
    defer gpu.close()
    data := make([]u8, 4 * 16 + 6 * 4)
    defer delete(data)
    for point, i in ([4][3]f64{{-1, -1, 0.25}, {1, -1, 0.25}, {1, 1, 0.25}, {-1, 1, 0.25}}) {
        for value, axis in point { r.putf(data, i * 16 + axis * 4, value) }
        r.put32(data, i * 16 + 12, 0xff0000ff)
    }
    for index, i in ([6]u32{0, 2, 1, 0, 3, 2}) { r.put32(data, 64 + i * 4, index) }
    identity := [16]f32{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1}
    draw := r.Resident_Draw {
        version      = 1,
        data         = data,
        vertex_count = 4,
        index_count  = 6,
        model        = identity,
        view         = identity,
        ambient      = 1,
    }
    color := make([]u8, 32 * 32 * 4)
    depth := make([]u8, len(color))
    defer delete(color)
    defer delete(depth)
    job := r.Raster_Job {
        draws     = []r.Resident_Draw{draw},
        color     = color,
        depth     = depth,
        width     = 32,
        height    = 32,
        clip      = {0, 0, 32, 32},
        fog_start = 1,
        fog_end   = 2,
    }
    for _ in 0 ..< 2 {
        for &value in color { value = 0 }
        for at := 0; at < len(depth); at += 4 { r.putf(depth, at, 1) }
        if !gpu.raster(job) ||
           r.u32le(color, (16 * 32 + 16) * 4) != 0xff0000ff ||
           r.f32le(depth, (16 * 32 + 16) * 4) != 0.25 { os.exit(1) }
    }
    if gpu.statistics() != ([3]u64{1, 1, 192}) || gpu.cached_bytes() != 192 { os.exit(1) }
    // Center depth must reject samples behind an existing nearer attachment.
    for &value in color { value = 0 }
    for at := 0; at < len(depth); at += 4 { r.putf(depth, at, 0.125) }
    if !gpu.raster(job) ||
       r.u32le(color, (16 * 32 + 16) * 4) != 0 ||
       r.f32le(depth, (16 * 32 + 16) * 4) != 0.125 { os.exit(1) }
    // Reverse winding: the sampled face points away and must disappear.
    for index, i in ([6]u32{0, 1, 2, 0, 2, 3}) { r.put32(data, 64 + i * 4, index) }
    job.draws[0].version = 2
    for at := 0; at < len(depth); at += 4 { r.putf(depth, at, 1) }
    if !gpu.raster(job) || r.u32le(color, (16 * 32 + 16) * 4) != 0 { os.exit(1) }
}
