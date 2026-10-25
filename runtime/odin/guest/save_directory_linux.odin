package guest

import "core:fmt"
import "core:os"

// Follows the XDG base directory rules: $XDG_DATA_HOME, else ~/.local/share. Returns an
// allocated path, or "" when neither is set.
default_save_directory :: proc() -> string {
    data := os.get_env("XDG_DATA_HOME", context.allocator)
    defer delete(data)
    if data != "" { return fmt.aprintf("%s/Bytorio/saves", data) }
    home := os.get_env("HOME", context.allocator)
    defer delete(home)
    if home == "" { return "" }
    return fmt.aprintf("%s/.local/share/Bytorio/saves", home)
}
