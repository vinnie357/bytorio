package guest

import "core:strings"
import "core:sys/posix"

// Moves without replacing; link() fails when the destination exists, and the
// caller removes the source name afterwards.
move_without_replace :: proc(from_path, to_path: string) -> bool {
    from := strings.clone_to_cstring(from_path, context.temp_allocator)
    to := strings.clone_to_cstring(to_path, context.temp_allocator)
    return posix.link(from, to) == .OK
}
