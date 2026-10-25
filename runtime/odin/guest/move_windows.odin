package guest

import win "core:sys/windows"

// Moves without replacing; fails when the destination exists.
move_without_replace :: proc(from_path, to_path: string) -> bool {
    from, to :=
        win.utf8_to_utf16(from_path, context.allocator),
        win.utf8_to_utf16(to_path, context.allocator)
    defer delete(from)
    defer delete(to)
    if from == nil || to == nil { return false }
    return bool(win.MoveFileExW(cstring16(raw_data(from)), cstring16(raw_data(to)), 0))
}
