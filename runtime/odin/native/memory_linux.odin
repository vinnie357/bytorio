package main
import "core:os"
import "core:strconv"
import "core:strings"

// Resident and peak resident set size from /proc/self/status, which reports kibibytes.
process_memory :: proc() -> (working, peak: uint) {
    text, read_error := os.read_entire_file("/proc/self/status", context.allocator)
    if read_error != nil { return 0, 0 }
    defer delete(text)
    remaining := string(text)
    for line in strings.split_lines_iterator(&remaining) {
        if value, ok := status_kibibytes(line, "VmRSS:"); ok { working = value * 1024 }
        if value, ok := status_kibibytes(line, "VmHWM:"); ok { peak = value * 1024 }
    }
    return
}

status_kibibytes :: proc(line, key: string) -> (value: uint, ok: bool) {
    if !strings.has_prefix(line, key) { return 0, false }
    fields := strings.fields(line[len(key):], context.temp_allocator)
    if len(fields) == 0 { return 0, false }
    parsed, parsed_ok := strconv.parse_uint(fields[0])
    return parsed, parsed_ok
}
