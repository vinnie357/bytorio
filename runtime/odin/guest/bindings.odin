package guest

// Handwritten subset of the Wasmtime 49.0.3 C API; no C/C++ runtime implementation.
when ODIN_OS == .Windows {
    foreign import wasmtime "deps:wasmtime.dll.lib"
} else when ODIN_OS == .Darwin {
    // Static archive from the pinned aarch64-macos C API.
    foreign import wasmtime "deps:libwasmtime.a"
}

Engine :: distinct rawptr
Config :: distinct rawptr
Store :: distinct rawptr
Context :: distinct rawptr
Module :: distinct rawptr
Linker :: distinct rawptr
Error :: distinct rawptr
Trap :: distinct rawptr
ByteVec :: struct {
    size: uint,
    data: [^]u8,
}
TypeVec :: struct {
    size: uint,
    data: [^]rawptr,
}
Func :: struct {
    store_id: u64,
    private:  rawptr,
}
// The C header has a nested anonymous struct; its trailing padding is significant.
StoreIndex :: struct {
    store_id: u64,
    private1: u32,
}
Memory :: struct {
    index:    StoreIndex,
    private2: u32,
}
Instance :: struct {
    store_id: u64,
    private:  uint,
}
ValUnion :: struct #raw_union {
    i32:       i32,
    i64:       i64,
    f32:       f32,
    f64:       f64,
    reference: [3]u64,
}
Val :: struct {
    kind: u8,
    of:   ValUnion,
}
ExternUnion :: struct #raw_union {
    function: Func,
    memory:   Memory,
    storage:  [3]u64,
}
Extern :: struct {
    kind: u8,
    of:   ExternUnion,
}
Callback :: #type proc "c" (
    environment, caller: rawptr,
    args: [^]Val,
    nargs: uint,
    results: [^]Val,
    nresults: uint,
) -> Trap
#assert(size_of(Val) == 32)
#assert(size_of(Extern) == 32)
#assert(size_of(Func) == 16)
#assert(size_of(Memory) == 24)
#assert(offset_of(Memory, private2) == 16)

@(default_calling_convention = "c")
foreign wasmtime {
    wasm_config_new :: proc() -> Config ---
    wasm_config_delete :: proc(config: Config) ---
    wasmtime_config_cache_config_load :: proc(config: Config, path: cstring) -> Error ---
    wasm_engine_new_with_config :: proc(config: Config) -> Engine ---
    wasm_engine_delete :: proc(engine: Engine) ---
    wasmtime_config_consume_fuel_set :: proc(config: Config, enabled: bool) ---
    wasmtime_config_max_wasm_stack_set :: proc(config: Config, bytes: uint) ---
    wasmtime_store_new :: proc(engine: Engine, data, finalizer: rawptr) -> Store ---
    wasmtime_store_context :: proc(store: Store) -> Context ---
    wasmtime_caller_context :: proc(caller: rawptr) -> Context ---
    wasmtime_caller_export_get :: proc(caller: rawptr, name: [^]u8, length: uint, out: ^Extern) -> bool ---
    wasmtime_store_delete :: proc(store: Store) ---
    wasmtime_store_limiter :: proc(store: Store, memory_size, table_elements, instances, tables, memories: i64) ---
    wasmtime_context_set_fuel :: proc(ctx: Context, fuel: u64) -> Error ---
    wasmtime_module_new :: proc(engine: Engine, bytes: [^]u8, length: uint, out: ^Module) -> Error ---
    wasmtime_module_delete :: proc(module: Module) ---
    wasmtime_linker_new :: proc(engine: Engine) -> Linker ---
    wasmtime_linker_delete :: proc(linker: Linker) ---
    wasmtime_linker_define_func :: proc(linker: Linker, module: [^]u8, module_len: uint, name: [^]u8, name_len: uint, function_type: rawptr, callback: Callback, environment, finalizer: rawptr) -> Error ---
    wasmtime_linker_instantiate :: proc(linker: Linker, ctx: Context, module: Module, instance: ^Instance, trap: ^Trap) -> Error ---
    wasm_valtype_new :: proc(kind: u8) -> rawptr ---
    wasm_valtype_kind :: proc(value: rawptr) -> u8 ---
    wasmtime_func_type :: proc(ctx: Context, function: ^Func) -> rawptr ---
    wasm_functype_params :: proc(function_type: rawptr) -> ^TypeVec ---
    wasm_functype_results :: proc(function_type: rawptr) -> ^TypeVec ---
    wasm_valtype_vec_new_uninitialized :: proc(vector: ^TypeVec, size: uint) ---
    wasm_functype_new :: proc(params, results: ^TypeVec) -> rawptr ---
    wasm_functype_delete :: proc(function_type: rawptr) ---
    wasmtime_instance_new :: proc(ctx: Context, module: Module, imports: [^]Extern, count: uint, out: ^Instance, trap: ^Trap) -> Error ---
    wasmtime_instance_export_get :: proc(ctx: Context, instance: ^Instance, name: [^]u8, length: uint, out: ^Extern) -> bool ---
    wasmtime_extern_delete :: proc(external: ^Extern) ---
    wasmtime_func_call :: proc(ctx: Context, function: ^Func, args: [^]Val, nargs: uint, results: [^]Val, nresults: uint, trap: ^Trap) -> Error ---
    wasmtime_memory_data :: proc(ctx: Context, memory: ^Memory) -> [^]u8 ---
    wasmtime_memory_type :: proc(ctx: Context, memory: ^Memory) -> rawptr ---
    wasmtime_memorytype_maximum :: proc(memory_type: rawptr, maximum: ^u64) -> bool ---
    wasmtime_memorytype_is64 :: proc(memory_type: rawptr) -> bool ---
    wasmtime_memorytype_isshared :: proc(memory_type: rawptr) -> bool ---
    wasmtime_memorytype_page_size :: proc(memory_type: rawptr) -> u64 ---
    wasm_memorytype_delete :: proc(memory_type: rawptr) ---
    wasmtime_memory_data_size :: proc(ctx: Context, memory: ^Memory) -> uint ---
    wasmtime_error_message :: proc(error: Error, message: ^ByteVec) ---
    wasmtime_error_delete :: proc(error: Error) ---
    wasm_trap_message :: proc(trap: Trap, message: ^ByteVec) ---
    wasm_trap_delete :: proc(trap: Trap) ---
    wasm_byte_vec_delete :: proc(vector: ^ByteVec) ---
}
