package gpu

import sdl "vendor:sdl3"

// open() passes i32(sdl.GLProfile.CORE), which is bit index 0 rather than the CORE mask. Mesa then
// hands out a compatibility context, so request the mask as a bit set. A forward-compatible
// flag is not needed for a 3.3 core context on Linux.
request_context_flags :: proc() {
    _ = sdl.GL_SetAttribute(.CONTEXT_PROFILE_MASK, transmute(i32)sdl.GLProfile{.CORE})
}
