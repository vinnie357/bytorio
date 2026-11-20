package guest

import "core:os"

// Creates the directory when missing. An existing directory is fine; an existing
// regular file is not, on every OS.
ensure_directory :: proc(path: string) -> bool {
    made := os.make_directory_all(path)
    if made == nil { return true }
    return made == .Exist && os.is_directory(path)
}
