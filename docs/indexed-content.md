# Indexed cartridge content

Design rationale: [immutable content separate from guest memory](adr/0007-separate-cartridge-content-from-guest-memory.md).

Cartridges may package immutable byte blobs outside their executable module.
Code has an 8 MiB limit for either a Wasm module or bundled Luau source. Odin
guest memory is capped at 8 MiB. Luau has a separate 64 MiB executor-memory
ceiling for its source and compiler, with a 4 MiB VM heap cap. Indexed content
does not increase these budgets, display modes or profile tuples.

Declare portable project-relative files in `bytorio.toml`:

```toml
[[content]]
id = 1
path = "assets/atlas.rgba"

[[content]]
id = 2
path = "assets/music.pcm"
```

The normal SDK check, build and pack commands include these entries. Direct
packaging with `encodeCartridge` accepts `content: [{ id, bytes }]`, where bytes
is a `Uint8Array` or Node buffer. IDs are unique positive unsigned 32-bit integers.
Entries must be nonempty. Asset names, codecs and application metadata are game
concerns; generate a small ID table alongside your game sources when needed.

Odin uses `import content "sdk:content"`, `content.size(id)` and
`content.read(id, offset, destination)` with a caller-owned `[]u8`. Luau uses
`byt.content.size(id)` and `byt.content.read(id, offset, destination)` with a
caller-owned `buffer`. Size zero means the ID is absent. Reads return a boolean,
copy exactly the destination length, and leave every destination byte unchanged
on rejection. Missing IDs, out-of-range source spans and reads above 1 MiB are
rejected. A zero-length read at the end of an existing entry succeeds. Luau
rejects noninteger or out-of-range IDs and offsets as argument errors.

Use a bounded staging buffer to read a texture frame or audio segment, upload it
through the existing resource APIs, and reuse the buffer after upload. Content
is not automatically decoded, drawn, mixed or charged to the resource registry.
The host retains the cartridge backing bytes until the cartridge is unloaded.
Reads never expose the host memory to a guest or permit writes to content.

The optional private ancillary PNG chunk `coNt` follows `caRt`. Its payload is
`CTNT`, a little-endian u32 version (1), a u32 entry count, then 12-byte records
`{ id, offset, length }`, followed by packed blob bytes. IDs strictly increase;
offsets are relative to the blob area and must describe contiguous nonempty
regions covering it exactly. Duplicate chunks, overlaps, gaps, unsorted IDs,
overflow, unsupported versions and trailing unindexed bytes are rejected before
publication. PNG CRC validation covers the complete chunk. Index and blobs
together are capped at 512 MiB and 65,536 entries. The cover and code retain their
separate 10 MiB PNG budget. These limits live in `sdk/contract.json`.

The host imports `env.content_size(i32)->i32` and
`env.content_read(i32,i32,i32,i32)->i32` supply access. The read arguments are ID,
source offset, guest destination pointer and length; return 1 indicates success.
The host checks the complete guest-memory range before copying. Existing
cartridges remain valid; content-using cartridges require an updated player.
The content format and API remain version 1. Files within the former 64 MiB
bound are unchanged; older players still reject files above their former bound.

Native parsing borrows the index and blobs from one cartridge allocation.
Browser file selection retains an immutable File/Blob instead of cloning a
complete ArrayBuffer into its worker. Files and uncompressed HTTP responses
with a declared length stream directly into one runtime allocation; only the
small executable is copied separately. Chunked or compressed HTTP responses
first collect bounded chunks into a Blob because their decoded length is not
known. Save identity still hashes the exact complete cartridge bytes. Content
capacity does not change the 1 MiB read bound, guest memory, module/cover limits,
runtime resource quotas, display profiles, or content lifetime.
The browser renderer's Wasm memory ceiling adds the bounded cartridge allocation
to its existing runtime allowance, rounded up to a Wasm page. This ceiling permits
the host backing storage; it does not preallocate the maximum or enlarge guest
memory or the resource registry's quota.

`mise run validate test:content` checks independent byte expectations through
both SDKs and native/browser players, malformed indexes, overflow, destination
bounds, failed-parse rollback and reload clearing. It is also included in
`test:cartridge` and the complete gate.
