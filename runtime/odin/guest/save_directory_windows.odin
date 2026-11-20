package guest

import "core:fmt"
import "core:os"

// Returns an allocated path, or "" when the platform has no per-user data directory.
default_save_directory :: proc() -> string {
    base := os.get_env("LOCALAPPDATA", context.allocator)
    defer delete(base)
    if base == "" { return "" }
    return fmt.aprintf("%s/Bytorio/saves", base)
}
