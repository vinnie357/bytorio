package native_platform

import guest "../../runtime/odin/guest"
import "core:fmt"
import "core:os"
import "core:testing"

@(test)
directory_creation :: proc(t: ^testing.T) {
    root := os.get_env("BYTORIO_NATIVE_TEST_ROOT", context.temp_allocator)
    testing.expect(t, len(root) > 0)
    directory := fmt.tprintf("%s/nested/directory", root)
    testing.expect(t, guest.ensure_directory(directory))
    testing.expect(t, guest.ensure_directory(directory), "an existing directory is reusable")
    file := fmt.tprintf("%s/regular-file", root)
    testing.expect(t, os.write_entire_file(file, []u8{1}) == nil)
    testing.expect(t, !guest.ensure_directory(file), "a regular file is not a cache directory")
}

@(test)
save_directory :: proc(t: ^testing.T) {
    directory := guest.default_save_directory()
    defer delete(directory)
    expected := os.get_env("BYTORIO_EXPECTED_SAVE_DIRECTORY", context.temp_allocator)
    testing.expect(t, len(expected) > 0)
    testing.expect_value(t, directory, expected)
}

@(test)
migration_publication :: proc(t: ^testing.T) {
    root := os.get_env("BYTORIO_NATIVE_TEST_ROOT", context.temp_allocator)
    source := fmt.tprintf("%s/migration-source", root)
    destination := fmt.tprintf("%s/migration-destination", root)
    testing.expect(t, os.write_entire_file(source, []u8{1, 2, 3}) == nil)
    testing.expect(t, os.write_entire_file(destination, []u8{4, 5, 6}) == nil)
    testing.expect(t, !guest.move_without_replace(source, destination))
    bytes, read_error := os.read_entire_file(destination, context.allocator)
    defer delete(bytes)
    testing.expect(t, read_error == nil)
    testing.expect(t, len(bytes) == 3 && bytes[0] == 4 && bytes[1] == 5 && bytes[2] == 6)
    fresh := fmt.tprintf("%s/migration-fresh", root)
    testing.expect(t, guest.move_without_replace(source, fresh))
    published, publish_error := os.read_entire_file(fresh, context.allocator)
    defer delete(published)
    testing.expect(t, publish_error == nil)
    testing.expect(
        t,
        len(published) == 3 && published[0] == 1 && published[1] == 2 && published[2] == 3,
    )
}
