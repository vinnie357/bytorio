package main
import "core:os"
import darwin "core:sys/darwin"
import "core:sys/posix"

process_memory :: proc() -> (working, peak: uint) {
    info: darwin.proc_taskinfo
    usage: posix.rusage
    if darwin.proc_pidinfo(posix.pid_t(os.get_pid()), .TASKINFO, 0, &info, size_of(info)) ==
       size_of(info) {
        working = uint(info.pti_resident_size)
    }
    // Darwin reports ru_maxrss in bytes.
    if posix.getrusage(.SELF, &usage) == .OK {
        peak = uint(usage.ru_maxrss)
    }
    return
}
