package main
import darwin "core:sys/darwin"

MACH_TASK_BASIC_INFO :: 20

// Mirrors mach_task_basic_info from <mach/task_info.h>.
Task_Basic_Info :: struct {
    virtual_size:      u64,
    resident_size:     u64,
    resident_size_max: u64,
    user_time:         [2]i32,
    system_time:       [2]i32,
    policy:            i32,
    suspend_count:     i32,
}

process_memory :: proc() -> (working, peak: uint) {
    info: Task_Basic_Info
    count := u32(size_of(info) / size_of(i32))
    status := darwin.task_info(
        darwin.mach_task_self(),
        MACH_TASK_BASIC_INFO,
        darwin.task_info_t(&info),
        &count,
    )
    if status != .Success { return 0, 0 }
    return uint(info.resident_size), uint(info.resident_size_max)
}
