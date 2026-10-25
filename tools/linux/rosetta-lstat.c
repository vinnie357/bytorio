// Rosetta leaves a stale `struct stat` behind when lstat() fails with ENOENT. Luau's isFile() in
// CLI/src/FileUtils.cpp ignores lstat's return value and reads st_mode, so a missing
// `.config.luau` looks like a regular file and luau-analyze rejects every `.luaurc`. Clearing the
// buffer on failure restores the result real hardware gives. Only the image preloads this.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <string.h>
#include <sys/stat.h>

int lstat(const char* path, struct stat* buffer)
{
    static int (*real)(const char*, struct stat*);
    if (!real)
        real = (int (*)(const char*, struct stat*))dlsym(RTLD_NEXT, "lstat");
    int result = real(path, buffer);
    if (result != 0)
        memset(buffer, 0, sizeof(*buffer));
    return result;
}
