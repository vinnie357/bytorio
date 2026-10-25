package main

import gpu "../../../runtime/odin/gpu/native"
import r "../../../runtime/odin/resources"
import "core:os"

verify_effect_blending :: proc() {
    for quality in ([3]int{1, 2, 6}) {
        if !gpu.open(quality) { os.exit(1) }
        color, depth: [32 * 32 * 4]u8
        texel := [4]u8{128, 0, 0, 128}
        // Two overlapping triangles exercise depth publication within a batch.
        vertices := [54]f32{}
        positions := [3][2]f32{{-0.8, -0.8}, {0, 0.8}, {0.8, -0.8}}
        for i in 0 ..< 6 {
            at := i * 9
            vertices[at], vertices[at + 1] = positions[i % 3][0], positions[i % 3][1]
            vertices[at + 2], vertices[at + 3] = 0.25, 1
            vertices[at + 4], vertices[at + 5], vertices[at + 6] = 255, 255, 255
        }
        job := r.Raster_Job {
            vertices = (cast([^]u8)&vertices[0])[:size_of(vertices)],
            color = color[:],
            depth = depth[:],
            width = 32,
            height = 32,
            clip = {0, 0, 32, 32},
            fog_start = 1,
            fog_end = 2,
            texture = {
                pixels           = texel[:],
                version          = 900,
                width            = 1,
                height           = 1,
                effect           = true,
                skip_depth_write = true,
            },
        }
        center := (16 * 32 + 16) * 4
        for scenario in 0 ..< 6 {
            for i in 0 ..< 6 { vertices[i * 9 + 2] = 1 if scenario == 5 else 0.25 }
            for at := 0; at < len(depth); at += 4 {
                r.put32(color[:], at, 0xffff0000)
                r.putf(depth[:], at, 0.1 if scenario >= 3 else 1)
            }
            job.texture.additive = scenario == 1
            job.texture.skip_depth_write = scenario != 2
            job.texture.skip_depth_test = scenario >= 4
            if !gpu.raster(job) { os.exit(1) }
            expected := [6]u32 {
                0xff3f00c0,
                0xffff00ff,
                0xff7f0080,
                0xffff0000,
                0xff3f00c0,
                0xff3f00c0,
            }
            // UNORM blending may round the second 127*127/255 by one byte.
            actual := r.u32le(color[:], center)
            for channel in 0 ..< 4 {
                a := int((actual >> u32(channel * 8)) & 255)
                b := int((expected[scenario] >> u32(channel * 8)) & 255)
                if abs(a - b) > 1 { os.exit(1) }
            }
            expected_depth := 0.25 if scenario == 2 else 0.1 if scenario >= 3 else 1.0
            if abs(r.f32le(depth[:], center) - expected_depth) > 0.00001 { os.exit(1) }
        }
        gpu.close()
    }
}
