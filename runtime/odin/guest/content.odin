package guest

import abi "../abi"
import cartridge "../cartridge"
import "base:runtime"

define_content_imports :: proc(game: ^Game) -> bool {
    names := [2]string{"content_size", "content_read"}
    for name, i in names {
        params, results: TypeVec
        count := 1 if i == 0 else 4
        wasm_valtype_vec_new_uninitialized(&params, uint(count))
        wasm_valtype_vec_new_uninitialized(&results, 1)
        for j in 0 ..< count {
            params.data[j] = wasm_valtype_new(0)
        }
        results.data[0] = wasm_valtype_new(0)
        signature := wasm_functype_new(&params, &results)
        callback := content_size_callback if i == 0 else content_read_callback
        result := wasmtime_linker_define_func(
            game.linker,
            raw_data(string("env")),
            3,
            raw_data(name),
            uint(len(name)),
            signature,
            callback,
            game,
            nil,
        )
        wasm_functype_delete(signature)
        if !check(game, result, nil) {
            return false
        }
    }
    return true
}

content_size_callback :: proc "c" (
    environment, _caller: rawptr,
    args: [^]Val,
    _nargs: uint,
    results: [^]Val,
    _nresults: uint,
) -> Trap {
    context = runtime.default_context()
    game := (^Game)(environment)
    results[0].kind = 0
    results[0].of.i32 = i32(len(cartridge.content_blob(game.content, u32(args[0].of.i32))))
    return nil
}

content_read_callback :: proc "c" (
    environment, caller: rawptr,
    args: [^]Val,
    _nargs: uint,
    results: [^]Val,
    _nresults: uint,
) -> Trap {
    context = runtime.default_context()
    results[0].kind, results[0].of.i32 = 0, 0
    game := (^Game)(environment)
    destination, size := u32(args[2].of.i32), u32(args[3].of.i32)
    if size > abi.MAX_CONTENT_READ_BYTES {
        return nil
    }
    external: Extern
    if !wasmtime_caller_export_get(caller, raw_data(string("memory")), 6, &external) {
        return nil
    }
    defer wasmtime_extern_delete(&external)
    if external.kind != 3 {
        return nil
    }
    ctx := wasmtime_caller_context(caller)
    memory_size := wasmtime_memory_data_size(ctx, &external.of.memory)
    if u64(destination) + u64(size) > u64(memory_size) {
        return nil
    }
    bytes := wasmtime_memory_data(ctx, &external.of.memory)[destination:destination + size]
    if cartridge.content_read(game.content, u32(args[0].of.i32), u32(args[1].of.i32), bytes) {
        results[0].of.i32 = 1
    }
    return nil
}
