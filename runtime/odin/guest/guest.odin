package guest

import abi "../abi"
import cartridge "../cartridge"
import w "../resource_protocol"
import resources "../resources"
import "base:runtime"
import "core:fmt"
import "core:math"
import "core:mem"
import "core:strings"
import "core:time"

Game :: struct {
    ogg:                                       [w.maxOggStreams]Ogg_Decoder,
    engine:                                    Engine,
    store:                                     Store,
    ctx:                                       Context,
    module:                                    Module,
    linker:                                    Linker,
    instance:                                  Instance,
    memory:                                    Memory,
    init, update, draw:                        Func,
    command_offset, command_count:             Func,
    has_commands:                              bool,
    commands:                                  [abi.MAX_COMMANDS]abi.Command,
    batch:                                     [abi.MAX_COMMANDS]abi.Draw_Command,
    text:                                      [abi.MAX_TEXT_BYTES]u8,
    assets:                                    [abi.MAX_GRAPHICS_BYTES]u8,
    text_size, stride:                         int,
    count:                                     int,
    display_mode:                              u32,
    has_source, metered:                       bool,
    cache_enabled:                             bool,
    compile_ms, instantiate_ms, initialize_ms: f64,
    error:                                     string,
    resources:                                 resources.Registry,
    resource_packet:                           []u8,
    resource_enabled:                          bool,
    resource_protocol:                         u32,
    profile:                                   u32,
    content:                                   cartridge.Content,
    save:                                      Save_State,
    text_input:                                abi.Text_State,
}

resource_session: u32

close :: proc(game: ^Game) {
    close_ogg(game)
    delete(game.save.directory)
    delete(game.save.path)
    resources.close(&game.resources)
    delete(game.resource_packet)
    if game.store != nil {

        wasmtime_store_delete(game.store)
    }
    if game.linker != nil {

        wasmtime_linker_delete(game.linker)
    }
    if game.module != nil {

        wasmtime_module_delete(game.module)
    }
    if game.engine != nil {

        wasm_engine_delete(game.engine)
    }
    delete(game.error)
    game^ = {}
}

fail :: proc(game: ^Game, message: string) -> bool {
    delete(game.error)
    game.error = strings.clone(message)
    return false
}

validate_sdk :: proc(game: ^Game, version: u32) -> bool {
    query: Func
    result: [1]Val
    if !function(game, "game_sdk_version", &query) || !call(game, &query, nil, result[:]) {

        return false
    }
    if result[0].kind != 0 || u32(result[0].of.i32) != version {

        return fail(game, "cartridge SDK version does not match its metadata")
    }
    return true
}

check :: proc(game: ^Game, error: Error, trap: Trap) -> bool {
    if error == nil && trap == nil {

        return true
    }
    message: ByteVec
    if error != nil {

        wasmtime_error_message(error, &message)
    } else {

        wasm_trap_message(trap, &message)
    }
    result := fail(game, string(message.data[:message.size]))
    wasm_byte_vec_delete(&message)
    if error != nil {

        wasmtime_error_delete(error)
    }
    if trap != nil {

        wasm_trap_delete(trap)
    }
    return result
}

call :: proc(game: ^Game, function: ^Func, args: []Val, result: []Val) -> bool {
    budget :=
        u64(500_000_000) if game.has_source else (u64(100_000_000) if game.resource_protocol >= 2 else u64(10_000_000))
    if game.metered && !check(game, wasmtime_context_set_fuel(game.ctx, budget), nil) {

        return false
    }
    trap: Trap
    error := wasmtime_func_call(
        game.ctx,
        function,
        raw_data(args),
        uint(len(args)),
        raw_data(result),
        uint(len(result)),
        &trap,
    )
    return check(game, error, trap)
}

function :: proc(game: ^Game, name: string, result: ^Func) -> bool {
    value: Extern
    if !wasmtime_instance_export_get(
        game.ctx,
        &game.instance,
        raw_data(name),
        uint(len(name)),
        &value,
    ) {
        return fail(game, "missing required game export")
    }
    defer wasmtime_extern_delete(&value)
    if value.kind != 0 {

        return fail(game, "required game export is not a function")
    }
    result^ = value.of.function
    return true
}
has_export :: proc(game: ^Game, name: string) -> bool {
    value: Extern
    if !wasmtime_instance_export_get(
        game.ctx,
        &game.instance,
        raw_data(name),
        uint(len(name)),
        &value,
    ) {

        return false
    }
    wasmtime_extern_delete(&value)
    return true
}
read_blob :: proc(game: ^Game, offset_name, size_name: string, destination: []u8) -> (int, bool) {
    offset_fn, size_fn: Func
    result: [1]Val
    if !function(game, offset_name, &offset_fn) ||
       !function(game, size_name, &size_fn) ||
       !call(game, &size_fn, nil, result[:]) {

        return 0, false
    }
    if result[0].kind != 0 || result[0].of.i32 < 0 || int(result[0].of.i32) > len(destination) {

        return 0, fail(game, "invalid guest blob size")
    }
    length := int(result[0].of.i32)
    if !call(game, &offset_fn, nil, result[:]) {

        return 0, false
    }
    if result[0].kind != 0 {

        return 0, fail(game, "invalid guest blob offset")
    }
    offset := uint(u32(result[0].of.i32))
    size := wasmtime_memory_data_size(game.ctx, &game.memory)
    if offset > size || uint(length) > size - offset {

        return 0, fail(game, "guest blob outside memory")
    }
    if length > 0 {

        mem.copy(
            raw_data(destination),
            &wasmtime_memory_data(game.ctx, &game.memory)[offset],
            length,
        )
    }
    return length, true
}
read_graphics :: proc(game: ^Game) -> (int, bool) {
    if !has_export(game, "game_assets") {

        return 0, true
    }
    return read_blob(game, "game_assets", "game_assets_size", game.assets[:])
}

load :: proc(
    game: ^Game,
    bytes: []u8,
    source: []u8 = nil,
    metered := true,
    cache_config := "",
    expected_profile: u32 = 0,
    content: cartridge.Content = {},
    save_identity: []u8 = nil,
    save_id: []u8 = nil,
    save_legacy: []u8 = nil,
) -> bool {
    game.content = content
    save_open(&game.save, save_identity, save_id, save_legacy)
    game.text_input.read_allowed = true
    if len(bytes) == 0 || len(bytes) > abi.MAX_GAME_BYTES {

        return fail(game, "game module exceeds prototype size limit")
    }
    config := wasm_config_new()
    game.has_source, game.metered = len(source) > 0, metered
    wasmtime_config_consume_fuel_set(config, metered)
    wasmtime_config_max_wasm_stack_set(config, 256 * 1024)
    if game.has_source && cache_config != "" {
        path := strings.clone_to_cstring(cache_config)
        cache_error := wasmtime_config_cache_config_load(config, path)
        delete(path)
        if !check(game, cache_error, nil) {

            wasm_config_delete(config)
            return false
        }
        game.cache_enabled = true
    }
    game.engine = wasm_engine_new_with_config(config)
    game.store = wasmtime_store_new(game.engine, nil, nil)
    game.ctx = wasmtime_store_context(game.store)
    memory_limit := i64(abi.MAX_LUAU_MEMORY_BYTES if game.has_source else abi.MAX_MEMORY_BYTES)
    wasmtime_store_limiter(game.store, memory_limit, 1024, 1, 1, 1)
    compile_start := time.tick_now()
    if !check(
        game,
        wasmtime_module_new(game.engine, raw_data(bytes), uint(len(bytes)), &game.module),
        nil,
    ) {

        return false
    }
    game.compile_ms = time.duration_seconds(time.tick_since(compile_start)) * 1000
    // Odin's freestanding math.sin lowers to this one explicitly allowed import.
    game.linker = wasmtime_linker_new(game.engine)
    if !define_content_imports(game) || !define_save_imports(game) || !define_text_imports(game) {
        return false
    }
    params, results: TypeVec
    wasm_valtype_vec_new_uninitialized(&params, 1)
    wasm_valtype_vec_new_uninitialized(&results, 1)
    params.data[0], results.data[0] = wasm_valtype_new(3), wasm_valtype_new(3)
    function_type := wasm_functype_new(&params, &results)
    defer wasm_functype_delete(function_type)
    if !check(
        game,
        wasmtime_linker_define_func(
            game.linker,
            raw_data(string("env")),
            3,
            raw_data(string("sin")),
            3,
            function_type,
            sine,
            nil,
            nil,
        ),
        nil,
    ) {

        return false
    }
    if metered && !check(game, wasmtime_context_set_fuel(game.ctx, 2_000_000), nil) {

        return false
    }
    trap: Trap
    instantiate_start := time.tick_now()
    error := wasmtime_linker_instantiate(game.linker, game.ctx, game.module, &game.instance, &trap)
    if !check(game, error, trap) {

        return false
    }
    game.instantiate_ms = time.duration_seconds(time.tick_since(instantiate_start)) * 1000
    initial_export: Extern
    if wasmtime_instance_export_get(
        game.ctx,
        &game.instance,
        raw_data(string("_initialize")),
        11,
        &initial_export,
    ) {
        wasmtime_extern_delete(&initial_export)
        initializer: Func
        if !function(game, "_initialize", &initializer) || !call(game, &initializer, nil, nil) {

            return false
        }
    }

    functions := [3]string{"game_init", "game_update", "game_draw"}
    for name in functions {
        target := &game.init
        if name == "game_update" {

            target = &game.update
        }
        if name == "game_draw" {

            target = &game.draw
        }
        if !function(game, name, target) {

            return false
        }
    }
    queries := [2]string{"game_abi", "game_frame_size"}
    for name, index in queries {
        query: Func
        if !function(game, name, &query) {

            return false
        }
        result: [1]Val
        if !call(game, &query, nil, result[:]) {

            return false
        }
        expected := i32(abi.VERSION)
        if index == 1 {

            expected = abi.FRAME_BYTES
        }
        if result[0].kind != 0 ||
           (index == 0 && result[0].of.i32 != 1 && result[0].of.i32 != abi.RESOURCE_ABI_VERSION) ||
           (index == 1 && result[0].of.i32 != expected) {

            return fail(game, "unsupported game ABI or frame size")
        }
    }
    memory: Extern
    if !wasmtime_instance_export_get(
        game.ctx,
        &game.instance,
        raw_data(string("memory")),
        6,
        &memory,
    ) {
        return fail(game, "game must export memory")
    }
    defer wasmtime_extern_delete(&memory)
    if memory.kind != 3 {

        return fail(game, "game memory export has wrong type")
    }
    game.memory = memory.of.memory
    memory_type := wasmtime_memory_type(game.ctx, &game.memory)
    defer wasm_memorytype_delete(memory_type)
    maximum: u64
    if !wasmtime_memorytype_maximum(memory_type, &maximum) ||
       maximum > u64(memory_limit / abi.WASM_PAGE_BYTES) ||
       wasmtime_memorytype_is64(memory_type) ||
       wasmtime_memorytype_isshared(memory_type) ||
       wasmtime_memorytype_page_size(memory_type) != abi.WASM_PAGE_BYTES {
        return fail(
            game,
            fmt.tprintf(
                "game memory must declare a %d MiB maximum or less",
                memory_limit / (1024 * 1024),
            ),
        )
    }
    extension: Extern
    if wasmtime_instance_export_get(
        game.ctx,
        &game.instance,
        raw_data(string("game_commands")),
        13,
        &extension,
    ) {
        wasmtime_extern_delete(&extension)
        if !function(game, "game_commands", &game.command_offset) ||
           !function(game, "game_command_count", &game.command_count) {

            return false
        }
        game.has_commands = true
    }
    game.stride = 20
    if has_export(game, "game_command_stride") {
        query: Func
        result: [1]Val
        if !function(game, "game_command_stride", &query) || !call(game, &query, nil, result[:]) {

            return false
        }
        if result[0].kind != 0 || (result[0].of.i32 != 20 && result[0].of.i32 != 32) {

            return fail(game, "unsupported command stride")
        }
        game.stride = int(result[0].of.i32)
    }
    initialize_start := time.tick_now()
    if game.has_source {
        if len(source) > abi.MAX_LUAU_SOURCE_BYTES {

            return fail(game, "Luau source exceeds prototype limit")
        }
        capacity, offset, setter: Func
        result: [1]Val
        allocate := has_export(game, "game_source_allocate")
        buffer_name := "game_source_allocate" if allocate else "game_source_buffer"
        if !function(game, "game_source_capacity", &capacity) ||
           !function(game, buffer_name, &offset) ||
           !function(game, "game_source_size", &setter) {

            return false
        }
        if !call(game, &capacity, nil, result[:]) {

            return false
        }
        if result[0].kind != 0 || result[0].of.i32 < i32(len(source)) {

            return fail(game, "source exceeds executor capacity")
        }
        allocation_args := [1]Val{{kind = 0, of = {i32 = i32(len(source))}}}
        if !call(game, &offset, allocation_args[:] if allocate else nil, result[:]) {

            return false
        }
        if result[0].kind != 0 {

            return fail(game, "invalid source buffer")
        }
        if allocate && result[0].of.i32 == 0 { return fail(game, "cannot allocate source buffer") }
        start := uint(u32(result[0].of.i32))
        memory_size := wasmtime_memory_data_size(game.ctx, &game.memory)
        if start > memory_size || uint(len(source)) > memory_size - start {

            return fail(game, "source buffer outside guest memory")
        }
        data := wasmtime_memory_data(game.ctx, &game.memory)
        mem.copy(&data[start], raw_data(source), len(source))
        args := [1]Val{{kind = 0, of = {i32 = i32(len(source))}}}
        if !call(game, &setter, args[:], nil) {

            return false
        }
    }
    if !negotiate_profile(game, expected_profile) || !initialize(game) {

        return false
    }
    game.initialize_ms = time.duration_seconds(time.tick_since(initialize_start)) * 1000
    return true
}

negotiate_profile :: proc(game: ^Game, expected: u32) -> bool {
    profile := u32(1)
    if has_export(game, "game_profile") {
        query: Func
        result: [1]Val
        if !function(game, "game_profile", &query) ||
           !call(game, &query, nil, result[:]) { return false }
        if result[0].kind != 0 { return fail(game, "invalid game profile") }
        profile = u32(result[0].of.i32)
    }
    if (profile != 1 &&
           profile != abi.PROFILE_RESOURCE &&
           profile != abi.PROFILE_3D &&
           profile != abi.PROFILE_TEXTURED_3D &&
           profile != abi.PROFILE_ALPHA_3D &&
           profile != abi.PROFILE_EFFECTS_3D &&
           profile != abi.PROFILE_OGG) ||
       (expected != 0 && expected != profile) {
        return fail(game, "unsupported or mismatched cartridge profile")
    }
    if profile != 1 {
        for signature in abi.RESOURCE_EXPORTS {
            query: Func
            if !function(game, signature.name, &query) { return false }
            kind := wasmtime_func_type(game.ctx, &query)
            defer wasm_functype_delete(kind)
            params, results := wasm_functype_params(kind), wasm_functype_results(kind)
            if params.size != uint(len(signature.params)) ||
               results.size != uint(len(signature.results)) {
                return fail(game, "invalid resource profile export signature")
            }
            for expected, i in transmute([]u8)signature.params {
                // Binary numeric types descend from 0x7f; C API kinds ascend from zero.
                if wasm_valtype_kind(params.data[i]) != 127 - expected {
                    return fail(game, "invalid resource profile export parameter")
                }
            }
            for expected, i in transmute([]u8)signature.results {
                if wasm_valtype_kind(results.data[i]) != 127 - expected {
                    return fail(game, "invalid resource profile export result")
                }
            }
        }
    }
    names := [4]string {
        "game_abi",
        "game_sdk_version",
        "game_resource_protocol",
        "game_required_features",
    }
    values := [4]u32 {
        abi.RESOURCE_ABI_VERSION,
        abi.RESOURCE_SDK_VERSION,
        abi.RESOURCE_PROTOCOL,
        abi.RESOURCE_FEATURES,
    }
    if profile == 1 { values[0] = 1 }
    if profile == abi.PROFILE_3D {
        values[1] = abi.PREVIEW_3D_SDK
        values[2] = abi.PREVIEW_3D_PROTOCOL
        values[3] = abi.PREVIEW_3D_FEATURES
    }
    if profile == abi.PROFILE_TEXTURED_3D {
        values[1], values[2], values[3] =
            abi.TEXTURED_3D_SDK, abi.TEXTURED_3D_PROTOCOL, abi.TEXTURED_3D_FEATURES
    }
    if profile == abi.PROFILE_EFFECTS_3D {
        values[1], values[2], values[3] =
            abi.EFFECTS_3D_SDK, abi.EFFECTS_3D_PROTOCOL, abi.EFFECTS_3D_FEATURES
    }
    if profile == abi.PROFILE_OGG {
        values[1], values[2], values[3] = abi.OGG_SDK, abi.OGG_PROTOCOL, abi.OGG_FEATURES
    }
    if profile == abi.PROFILE_ALPHA_3D {
        values[1], values[2], values[3] =
            abi.ALPHA_3D_SDK, abi.ALPHA_3D_PROTOCOL, abi.ALPHA_3D_FEATURES
    }
    for name, index in names {
        if profile == 1 && index > 0 { continue }
        query: Func
        result: [1]Val
        if !function(game, name, &query) || !call(game, &query, nil, result[:]) { return false }
        if result[0].kind != 0 || u32(result[0].of.i32) != values[index] {
            return fail(game, "unsupported resource profile SDK, ABI, features or protocol")
        }
    }
    if expected == 1 && !validate_sdk(game, 256) { return false }
    game.profile = profile
    return true
}

executor_ok :: proc(game: ^Game) -> bool {
    if !has_export(game, "game_error_length") {

        return true
    }
    length_fn, offset_fn: Func
    result: [1]Val
    if !function(game, "game_error_length", &length_fn) ||
       !call(game, &length_fn, nil, result[:]) {

        return false
    }
    if result[0].kind != 0 || result[0].of.i32 < 0 || result[0].of.i32 > 1024 {

        return fail(game, "invalid executor diagnostic")
    }
    length := uint(result[0].of.i32)
    if length == 0 {

        return true
    }
    if !function(game, "game_error", &offset_fn) || !call(game, &offset_fn, nil, result[:]) {

        return false
    }
    if result[0].kind != 0 {

        return fail(game, "invalid executor diagnostic offset")
    }
    offset := uint(u32(result[0].of.i32))
    size := wasmtime_memory_data_size(game.ctx, &game.memory)
    if offset > size || length > size - offset {

        return fail(game, "executor diagnostic outside memory")
    }
    data := wasmtime_memory_data(game.ctx, &game.memory)
    return fail(game, string(data[offset:offset + length]))
}

heap_query :: proc(game: ^Game, name: string) -> u32 {
    if !game.has_source {

        return 0
    }
    query: Func
    result: [1]Val
    if !function(game, name, &query) || !call(game, &query, nil, result[:]) {

        return 0
    }
    return u32(result[0].of.i32)
}

memory_bytes :: proc(game: ^Game) -> uint {
    return wasmtime_memory_data_size(game.ctx, &game.memory)
}

sine :: proc "c" (
    _environment, _caller: rawptr,
    args: [^]Val,
    _nargs: uint,
    results: [^]Val,
    _nresults: uint,
) -> Trap {
    context = runtime.default_context()
    results[0].kind, results[0].of.f64 = 3, math.sin(args[0].of.f64)
    return nil
}

update :: proc(game: ^Game, input: abi.Input) -> bool {
    game.text_input.read_allowed = true
    game.save.write_allowed = true
    if !deliver_resources(game) {

        return false
    }
    args: [4]Val
    args[0].kind, args[0].of.i32 = 0, i32(input.buttons)
    args[1].kind, args[1].of.i32 = 0, i32(input.pointer)
    args[2].kind, args[2].of.f64 = 3, input.x
    args[3].kind, args[3].of.f64 = 3, input.y
    return call(game, &game.update, args[:], nil) && executor_ok(game) && commit_resources(game)
}

initialize :: proc(game: ^Game) -> bool {
    game.save.write_allowed = true
    game.resource_enabled = has_export(game, "game_resource_protocol")
    if game.resource_enabled {
        protocol, configure: Func
        result: [1]Val
        if !function(game, "game_resource_protocol", &protocol) ||
           !call(game, &protocol, nil, result[:]) {

            return false
        }
        if result[0].kind != 0 || (result[0].of.i32 < 1 || result[0].of.i32 > w.version) {

            return fail(game, "unsupported internal resource protocol")
        }
        game.resource_protocol = u32(result[0].of.i32)
        if game.profile != abi.PROFILE_3D &&
           game.profile != abi.PROFILE_TEXTURED_3D &&
           game.profile != abi.PROFILE_ALPHA_3D &&
           game.profile != abi.PROFILE_EFFECTS_3D &&
           game.profile != abi.PROFILE_OGG &&
           game.resource_protocol > abi.RESOURCE_PROTOCOL {
            return fail(game, "experimental 3D requires its explicit cartridge profile")
        }
        if game.resource_protocol >= 2 {
            mailbox: Func
            names := [3]string {
                "game_resource_mailbox",
                "game_resource_mailbox_capacity",
                "game_resource_mailbox_size",
            }
            for name in names {

                if !function(game, name, &mailbox) {

                    return false
                }
            }
            if !function(game, "game_resource_mailbox_capacity", &mailbox) ||
               !call(game, &mailbox, nil, result[:]) {

                return false
            }
            if result[0].kind != 0 ||
               result[0].of.i32 <
                   (resources.MAILBOX_CAPACITY if game.resource_protocol >= 3 else resources.LEGACY_MAILBOX_CAPACITY) ||
               result[0].of.i32 > abi.MAX_MEMORY_BYTES {

                return fail(game, "invalid completion mailbox capacity")
            }
        }
        if resource_session == max(u32) {

            return fail(game, "resource session counter exhausted")
        }
        resource_session += 1
        game.resources.content = game.content
        if !resources.reset(&game.resources, resource_session, game.resource_protocol) {

            return fail(game, game.resources.error)
        }
        if len(game.resource_packet) == 0 {
            packet, allocation_error := make([]u8, resources.PACKET_BYTES)
            if allocation_error != nil {

                return fail(game, "cannot allocate resource packet snapshot")
            }
            game.resource_packet = packet
        }
        args := [1]Val{{kind = 0, of = {i32 = i32(resource_session)}}}
        if !function(game, "game_resource_configure", &configure) ||
           !call(game, &configure, args[:], result[:]) {

            return false
        }
        if result[0].kind != 0 || result[0].of.i32 != 1 {

            return fail(game, "resource configuration rejected")
        }
    }
    return call(game, &game.init, nil, nil) && executor_ok(game) && commit_resources(game)
}

commit_resources :: proc(game: ^Game) -> bool {
    if !game.resource_enabled {

        return true
    }
    commit, size_fn, ack: Func
    result: [1]Val
    if !function(game, "game_commit", &commit) ||
       !call(game, &commit, nil, result[:]) ||
       !executor_ok(game) {

        return false
    }
    if result[0].kind != 0 {

        return fail(game, "invalid resource packet offset")
    }
    offset := uint(u32(result[0].of.i32))
    if !function(game, "game_commit_size", &size_fn) || !call(game, &size_fn, nil, result[:]) {

        return false
    }
    if result[0].kind != 0 || result[0].of.i32 < 64 || result[0].of.i32 > resources.PACKET_BYTES {

        return fail(game, "invalid resource packet size")
    }
    length := int(result[0].of.i32)
    size := wasmtime_memory_data_size(game.ctx, &game.memory)
    if offset > size || uint(length) > size - offset {

        return fail(game, "resource packet outside guest memory")
    }
    packet := game.resource_packet[:length]
    mem.copy(raw_data(packet), &wasmtime_memory_data(game.ctx, &game.memory)[offset], length)
    mode := game.display_mode if abi.valid_display(game.display_mode) else abi.DISPLAY_HIGH
    if !resources.submit(&game.resources, packet, display = mode) {

        return fail(
            game,
            fmt.tprintf("resource command %d: %s", game.resources.command, game.resources.error),
        )
    }
    args := [1]Val{{kind = 0, of = {i32 = i32(game.resources.sequence)}}}
    if !function(game, "game_commit_ack", &ack) || !call(game, &ack, args[:], result[:]) {

        return false
    }
    return(
        (result[0].kind == 0 && result[0].of.i32 == 1) ||
        fail(game, "resource acknowledgement rejected") \
    )
}

resource_hash :: proc(game: ^Game) -> u32 {

    return resources.hash(&game.resources)
}
apply_graphics :: proc(game: ^Game) {

    resources.apply_output(&game.resources)
}
materialize_graphics :: proc(game: ^Game) -> bool {
    if !resources.materialize(&game.resources) { return fail(game, game.resources.error) }
    apply_graphics(game)
    return true
}
deliver_resources :: proc(game: ^Game) -> bool {
    if game.resource_protocol < 2 {

        return true
    }
    size := resources.mailbox(&game.resources, game.resource_packet)
    offset_fn, capacity_fn, setter: Func
    result: [1]Val
    if !function(game, "game_resource_mailbox_capacity", &capacity_fn) ||
       !call(game, &capacity_fn, nil, result[:]) {

        return false
    }
    if result[0].kind != 0 || result[0].of.i32 < i32(size) {

        return fail(game, "completion exceeds guest mailbox capacity")
    }
    if !function(game, "game_resource_mailbox", &offset_fn) ||
       !call(game, &offset_fn, nil, result[:]) {

        return false
    }
    if result[0].kind != 0 {

        return fail(game, "invalid guest mailbox offset")
    }
    offset := uint(u32(result[0].of.i32))
    memory_size := wasmtime_memory_data_size(game.ctx, &game.memory)
    if offset > memory_size || uint(size) > memory_size - offset {

        return fail(game, "completion mailbox outside guest memory")
    }
    mem.copy(
        &wasmtime_memory_data(game.ctx, &game.memory)[offset],
        raw_data(game.resource_packet),
        size,
    )
    args := [1]Val{{kind = 0, of = {i32 = i32(size)}}}
    if !function(game, "game_resource_mailbox_size", &setter) ||
       !call(game, &setter, args[:], result[:]) {

        return false
    }
    return(
        (result[0].kind == 0 && result[0].of.i32 == 1) ||
        fail(game, "completion mailbox rejected") \
    )
}

draw :: proc(game: ^Game, frame: ^abi.Frame) -> bool {
    result: [1]Val
    if !call(game, &game.draw, nil, result[:]) || !executor_ok(game) {

        return false
    }
    if result[0].kind != 0 {

        return fail(game, "game_draw must return a frame offset")
    }
    offset := uint(u32(result[0].of.i32))
    size := wasmtime_memory_data_size(game.ctx, &game.memory)
    if offset > size || size - offset < abi.FRAME_BYTES {

        return fail(game, "frame offset outside guest memory")
    }
    data := wasmtime_memory_data(game.ctx, &game.memory)
    mem.copy(frame, &data[offset], abi.FRAME_BYTES)
    game.display_mode = abi.DISPLAY_HIGH
    if has_export(game, "game_display_mode") {
        mode_fn: Func
        if !function(game, "game_display_mode", &mode_fn) ||
           !call(game, &mode_fn, nil, result[:]) {

            return false
        }
        if result[0].kind != 0 || !abi.valid_display(u32(result[0].of.i32)) {

            return fail(game, "unsupported display mode")
        }
        game.display_mode = u32(result[0].of.i32)
    }
    game.count = 0
    if game.has_commands {
        if !call(game, &game.command_count, nil, result[:]) {

            return false
        }
        if result[0].kind != 0 || result[0].of.i32 < 0 || result[0].of.i32 > abi.MAX_COMMANDS {

            return fail(game, "invalid display list length")
        }
        game.count = int(result[0].of.i32)
        if !call(game, &game.command_offset, nil, result[:]) {

            return false
        }
        if result[0].kind != 0 {

            return fail(game, "invalid display list offset")
        }
        command_offset := uint(u32(result[0].of.i32))
        command_bytes := uint(game.count * game.stride)
        // Reacquire memory after guest calls, which may grow it.
        size = wasmtime_memory_data_size(game.ctx, &game.memory)
        data = wasmtime_memory_data(game.ctx, &game.memory)
        if command_offset > size || command_bytes > size - command_offset {

            return fail(game, "display list outside guest memory")
        }
        destination: rawptr = &game.commands
        if game.stride == 32 {

            destination = &game.batch
        }
        if command_bytes > 0 {

            mem.copy(destination, &data[command_offset], int(command_bytes))
        }
        game.text_size = 0
        if game.stride == 32 {
            length, ok := read_blob(game, "game_text", "game_text_size", game.text[:])
            if !ok {

                return false
            }
            game.text_size = length
        }
    }
    if game.resource_protocol >= 2 {

        return commit_resources(game)
    }
    return true
}
