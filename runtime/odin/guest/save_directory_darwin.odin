package guest

import "core:fmt"
import "core:os"

// Returns an allocated path, or "" when the platform has no per-user data directory.
default_save_directory :: proc() -> string {
    home := os.get_env("HOME", context.allocator)
    defer delete(home)
    if home == "" { return "" }
    return fmt.aprintf("%s/Library/Application Support/Bytorio/saves", home)
}
