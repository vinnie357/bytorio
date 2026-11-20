package guest

import abi "../abi"
import "base:runtime"

define_text_imports :: proc(game: ^Game) -> bool {
    names := [2]string{"text_configure", "text_read"}
    for name, i in names {
        params, results: TypeVec
        wasm_valtype_vec_new_uninitialized(&params, 2)
        wasm_valtype_vec_new_uninitialized(&results, 1)
        params.data[0] = wasm_valtype_new(0)
        params.data[1] = wasm_valtype_new(0)
        results.data[0] = wasm_valtype_new(0)
        signature := wasm_functype_new(&params, &results)
        callback := text_configure_callback if i == 0 else text_read_callback
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
        if !check(game, result, nil) { return false }
    }
    return true
}

text_configure_callback :: proc "c" (
    environment, caller: rawptr,
    args: [^]Val,
    _nargs: uint,
    results: [^]Val,
    _nresults: uint,
) -> Trap {
    context = runtime.default_context()
    results[0].kind, results[0].of.i32 = 0, 0
    length := u32(args[1].of.i32)
    if length > size_of(abi.Text_Packet) { return nil }
    source, ok := save_memory(caller, u32(args[0].of.i32), length)
    if ok && abi.text_configure(&(^Game)(environment).text_input, source) {
        results[0].of.i32 = 1
    }
    return nil
}

text_read_callback :: proc "c" (
    environment, caller: rawptr,
    args: [^]Val,
    _nargs: uint,
    results: [^]Val,
    _nresults: uint,
) -> Trap {
    context = runtime.default_context()
    results[0].kind, results[0].of.i32 = 0, 0
    capacity := u32(args[1].of.i32)
    if capacity > size_of(abi.Text_Packet) { return nil }
    destination, ok := save_memory(caller, u32(args[0].of.i32), capacity)
    if ok {
        results[0].of.i32 = i32(abi.text_read(&(^Game)(environment).text_input, destination))
    }
    return nil
}
