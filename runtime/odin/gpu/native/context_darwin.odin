package gpu

import sdl "vendor:sdl3"

// macOS only offers OpenGL 3.3 as a forward-compatible core profile. open() passes
// i32(sdl.GLProfile.CORE), which is bit index 0 rather than the CORE mask value, so the
// profile mask is requested again here as a bit set.
request_context_flags :: proc() {
    _ = sdl.GL_SetAttribute(.CONTEXT_PROFILE_MASK, transmute(i32)sdl.GLProfile{.CORE})
    _ = sdl.GL_SetAttribute(.CONTEXT_FLAGS, transmute(i32)sdl.GLContextFlag{.FORWARD_COMPATIBLE})
}
