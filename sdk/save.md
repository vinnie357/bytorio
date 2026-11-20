# Save slot version 1

Design rationale: [opaque save snapshots](../docs/adr/0015-persist-opaque-save-snapshots.md)
and [explicit stable save identity](../docs/adr/0016-declare-stable-save-identity.md).

Each cartridge has one persistent slot containing 1–65536 bytes (64 KiB). Luau uses
`byt.save`; Odin imports `save "sdk:save"`. Games own their record format,
versioning, checksums and migrations. The host stores opaque bytes.

The interface remains version 1 after expanding its bound from 4096 bytes.
Existing records within the former bound remain readable without migration.
Older players still enforce their smaller bound and cannot load larger records.

| Operation                            | Luau                               | Odin                          |
| ------------------------------------ | ---------------------------------- | ----------------------------- |
| Committed length, zero when absent   | `byt.save.size()`                  | `save.size()`                 |
| Copy complete committed record       | `byt.save.read(destinationBuffer)` | `save.read(destinationSlice)` |
| Submit replacement snapshot          | `byt.save.write(sourceBuffer)`     | `save.write(sourceSlice)`     |
| Most recent storage operation status | `byt.save.status()`                | `save.status()`               |
| Maximum bytes                        | `byt.save.max_bytes`               | `save.MAX_BYTES`              |
| Interface version                    | `byt.save.version`                 | `save.VERSION`                |

`read` returns the actual record length. It returns zero for an absent record,
an insufficient destination, or a destination larger than 65536 bytes. Rejected
reads leave the whole destination unchanged. Reads see the last committed
snapshot, including while a newer write is pending or after a failed write.

`write` returns one of the following statuses; `status` queries the latest
accepted storage operation. Invalid arguments, another pending write, or a
second write in the same simulation tick return Error without changing the
existing operation status. Initialization permits one write, then each update
permits one more. Additional draw calls do not replenish this allowance.

| Value | Luau constant | Odin enum  | Meaning                                                  |
| ----- | ------------- | ---------- | -------------------------------------------------------- |
| 0     | `empty`       | `.Empty`   | No committed record exists                               |
| 1     | `ready`       | `.Ready`   | A record was loaded or a write committed successfully    |
| 2     | `pending`     | `.Pending` | Browser write accepted; transaction is still pending     |
| 3     | `error`       | `.Error`   | Storage unavailable, record invalid, or operation failed |

The native host finishes each accepted write synchronously. It writes a complete
temporary file before atomically replacing the prior save. Failed replacement
preserves the prior file. The browser copies source bytes immediately and writes
them in an IndexedDB transaction. After Pending, poll `status()` in later updates
until Ready or Error before showing a successful-save message or exiting. Closing
the browser or terminating its worker while Pending may lose that write. Ready
confirms successful filesystem replacement or IndexedDB transaction completion;
it does not promise survival of storage-device failure.

The game may reuse its staging buffer immediately after `write` returns. The
host rejects oversized input before copying and cannot expose arbitrary files.
There is no filename argument, directory access, or placeholder success result.

Declare a stable identity in `bytorio.toml` to retain saves across compatible
rebuilds, cover/assets/code changes and file renames in either SDK:

```toml
[save]
id = "org.example.game.compat-v1"
legacy = []
```

IDs contain 1–128 lowercase ASCII letters/digits, with single dot or hyphen
separators. Choose a distinct ID for unrelated games or incompatible save formats.
The slot key is SHA-256 of UTF-8 `bytorio-save-v1\0` followed by the ID (the
separator is one NUL byte). Titles and file paths never determine sharing.
Without a declaration, the key remains SHA-256 of the complete PNG. Unpackaged
development games retain their raw module/source hash identity.

The optional `legacy` array lists up to 16 unique lowercase 64-digit SHA-256
keys of older complete cartridges, in priority order. Only when the stable slot
is absent does the host adopt the first existing legacy record. It preserves the
old copy and atomically creates the canonical slot; a concurrent canonical writer
wins. A corrupt canonical or first existing legacy record reports Error without
fallback or overwrite. Failed adoption leaves the legacy data intact and reports
Error. This migrates storage keys only: the game owns record-format compatibility.

The SDK stores this declaration in one optional private ancillary PNG `saVe`
chunk after `caRt`. Its four-byte header is version (1), ASCII ID byte count,
legacy digest count and reserved zero; ID bytes precede ordered 32-byte raw SHA-256
digests. Duplicate, misplaced, malformed or unsupported metadata rejects loading.
Both hosts use the same bounded Odin parser and borrow metadata from the retained
PNG; browser callers copy metadata before growing runtime memory. Older players
ignore this optional chunk and continue using the whole-PNG key. The cartridge
profile, guest ABI and save interface version are unchanged.

Native saves live in the operating
system's local application-data directory under `Bytorio/saves`. Host tooling may
override that directory with `BYTORIO_SAVE_DIRECTORY`. Browser saves belong to
the player origin and are independent from native saves. Storage is local to the
device; private browsing, cleared site data or browser quota can prevent or erase
browser saves.

Run `mise run validate test:save` for maximum-size snapshots, independent byte
expectations, bounds, restart, separate cartridge identities, native atomic
replacement failure, and browser transaction rollback checks through both SDKs.
