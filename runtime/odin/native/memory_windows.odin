package main
import windows "core:sys/windows"

process_memory :: proc() -> (working, peak: uint) {
    counters := windows.PROCESS_MEMORY_COUNTERS {
        cb = size_of(windows.PROCESS_MEMORY_COUNTERS),
    }
    if !bool(
        windows.GetProcessMemoryInfo(windows.GetCurrentProcess(), &counters, size_of(counters)),
    ) {

        return 0, 0
    }
    return counters.WorkingSetSize, counters.PeakWorkingSetSize
}
