package audio_test

import "core:mem"

Poisoned_Allocation :: struct {
    size, alignment: int,
}

Poisoning_Allocator :: struct {
    backing:     mem.Allocator,
    allocations: map[rawptr]Poisoned_Allocation,
}

poisoning_allocator :: proc(
    state: ^Poisoning_Allocator,
    backing := context.allocator,
) -> mem.Allocator {
    state.backing = backing
    state.allocations.allocator = backing
    return {procedure = poisoning_allocator_proc, data = state}
}

poisoning_allocator_destroy :: proc(state: ^Poisoning_Allocator) {
    assert(len(state.allocations) == 0, "poisoning allocator has outstanding allocations")
    delete(state.allocations)
}

poisoning_allocator_proc :: proc(
    allocator_data: rawptr,
    mode: mem.Allocator_Mode,
    size, alignment: int,
    old_memory: rawptr,
    old_size: int,
    loc := #caller_location,
) -> (
    []u8,
    mem.Allocator_Error,
) {
    state := (^Poisoning_Allocator)(allocator_data)
    switch mode {
    case .Alloc, .Alloc_Non_Zeroed:
        block, err := state.backing.procedure(
            state.backing.data,
            mode,
            size,
            alignment,
            old_memory,
            old_size,
            loc,
        )
        if err == nil && raw_data(block) != nil {
            state.allocations[raw_data(block)] = {len(block), alignment}
        }
        return block, err
    case .Free:
        if old_memory == nil { return nil, nil }
        allocation, tracked := state.allocations[old_memory]
        if !tracked { panic("poisoning allocator cannot free an untracked allocation") }
        mem.set(old_memory, 0xA5, allocation.size)
        block, err := state.backing.procedure(
            state.backing.data,
            mode,
            size,
            alignment,
            old_memory,
            old_size,
            loc,
        )
        if err == nil { delete_key(&state.allocations, old_memory) }
        return block, err
    case .Resize, .Resize_Non_Zeroed:
        previous_size := old_size
        if old_memory != nil && previous_size == 0 {
            allocation, tracked := state.allocations[old_memory]
            if !tracked { return nil, .Invalid_Pointer }
            previous_size = allocation.size
        }
        previous := mem.byte_slice(old_memory, previous_size)
        allocator := mem.Allocator {
            procedure = poisoning_allocator_proc,
            data      = state,
        }
        // Route resize frees through this wrapper so they are poisoned before release too.
        if mode == .Resize_Non_Zeroed {
            return mem.default_resize_bytes_align_non_zeroed(
                previous,
                size,
                alignment,
                allocator,
                loc,
            )
        }
        return mem.default_resize_bytes_align(previous, size, alignment, allocator, loc)
    case .Query_Features:
        features := (^mem.Allocator_Mode_Set)(old_memory)
        if features != nil {
            features^ = {
                .Alloc,
                .Alloc_Non_Zeroed,
                .Free,
                .Resize,
                .Resize_Non_Zeroed,
                .Query_Features,
                .Query_Info,
            }
        }
        return nil, nil
    case .Query_Info:
        info := (^mem.Allocator_Query_Info)(old_memory)
        if info != nil && info.pointer != nil {
            if allocation, tracked := state.allocations[info.pointer]; tracked {
                info.size = allocation.size
                info.alignment = allocation.alignment
            }
            info.pointer = nil
        }
        return nil, nil
    case .Free_All:
        return nil, .Mode_Not_Implemented
    }
    return nil, .Mode_Not_Implemented
}
