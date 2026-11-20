# PNG cartridges, container version 1

Design rationale: [complete games in viewable PNG cartridges](adr/0005-distribute-complete-games-as-png-cartridges.md).

Both cartridge languages can be distributed as one ordinary, viewable `.png`
file. The PNG carries the complete bundled game: Luau source and its embedded
assets, or an Odin Wasm module and its embedded assets. Optional
[indexed content](indexed-content.md) stores larger immutable blobs separately
from code. The console supplies the
Luau executor, renderer and audio; these are runtime components, not game data.

## Package and play

With `byt` installed, from the folder containing your game project:

```text
byt pack my-game
byt pack my-game --output dist/my-game.png --cover art/cover.png
```

`build`, `run` and `dev` also produce `build/game.png`. Plain build exports web;
`--target native` or `--target all` selects native output explicitly. Each selected
player folder includes its cartridge. Without custom art, packaging creates a 256×256
cover from the title, first sprite, palette and bitmap font. An optional `cover`
path in `bytorio.toml` selects project-relative PNG artwork; `pack --cover`
overrides it. Custom covers retain their original image chunks. The packer rejects
an existing cartridge as cover art rather than nesting another game.

Native: `player.exe --game my-game.png`, or `player.exe my-game.png`. With no
argument the player prefers `game.png` beside the executable, then `game.wasm`.
Luau support requires the player-supplied `luau-executor.wasm` beside the player,
or an explicit `--executor` path. SDK builds of Luau projects include that module
and its licenses. Odin-only distributions do not need Luau tooling or its executor.

Browser: open `player.html?game=./my-game.png`, use **Open cartridge**, or drop the
PNG on the player. Selecting a local file reads it on the device; it is not
uploaded. Click **Start game** to enable audio. A Luau-enabled player can open
either language; each cartridge receives fresh game state while the compiled
Luau executor remains cached. Original loose development files still work.

RPG and racing builds emit two PNGs beside each shared player:
`rpg-luau.png` / `rpg-odin.png` and `racing-luau.png` / `racing-odin.png`.
Their comparison launchers now load these cartridges.

Send the original PNG file. Some image editors, resizing tools and image-sharing
services remove unfamiliar chunks when re-encoding images, which removes the game.

## PNG envelope

The standard PNG signature and ordinary image chunks are followed by exactly one
private ancillary chunk named **`caRt`**, after the last `IDAT` and before `IEND`.
Other ancillary chunks may follow it. Its lowercase final letter marks it safe to
copy because game data does not depend on cover pixels. These chunk properties,
big-endian chunk lengths and CRC-32 follow the
[W3C PNG specification](https://www.w3.org/TR/png-3/#5Chunk-layout).
The game payload is not stored in pixel colors or appended after `IEND`.

The current player accepts a **10 MiB** base PNG plus an optional **512 MiB**
indexed-content payload and its 12-byte PNG chunk envelope, covers from 1×1 through
1024×1024, at most 4,096 chunks, and a single static image. Standard grayscale,
RGB, indexed and alpha PNG header encodings are accepted. The cartridge parser
validates the signature, chunk boundaries, names, checksums, critical chunk
order, palette bounds, header fields and end-of-file. It does not inflate or
render image data; the console needs only the private payload. Ordinary image
decoders display the cover independently. APNG covers and unknown critical chunks
are rejected. CRC-32 detects accidental damage; it does not authenticate authors.

An optional private ancillary `saVe` chunk after `caRt` declares a stable save
identity and explicit legacy keys. It counts toward the base PNG size bound.
See [save identity and migration](../sdk/save.md) for its bounded binary layout,
validation and authoring contract. Older players ignore this chunk; no container,
profile or guest ABI version changes are required.

## Private chunk payload

The first 32 bytes are a fixed header. All multibyte fields inside this private
payload are **little-endian**, independently of the surrounding PNG envelope.

| Offset | Type | Field |
| --- | --- | --- |
| 0 | 4 bytes | ASCII `CART` |
| 4 | u16 | Container version: 1 |
| 6 | u8 | Language: 1 Luau, 2 Odin |
| 7 | u8 | Profile: 1 (`2d-preview-1`) or 2 (`resource-av-1`) |
| 8 | u32 | SDK version word: 256 for profile 1; 512 (0.2.0) for profile 2 |
| 12 | u32 | Game ABI: 1 for profile 1; 2 for profile 2 |
| 16 | u16 | Initial display width: 320 or 640 |
| 18 | u16 | Initial display height: 180 or 360, paired with width |
| 20 | u32 | Title byte length, 1..128 |
| 24 | u32 | Code byte length |
| 28 | u32 | Reserved flags: zero |

Exactly the title bytes, then code bytes, follow the header. No padding, extra
entries, external paths or optional executor are allowed. The title is valid
UTF-8 without ASCII controls or DEL. Luau code is UTF-8, at most 8 MiB. Odin code
is a Wasm version-1 module, at most 8 MiB. Neither code section is compressed.
Sprites and fonts are already embedded by the SDK. Both players check the
cartridge SDK/ABI/profile before initialization and initial display afterward, and retain the
existing guest memory, ABI, drawing, execution and diagnostic checks.

The module-size budget includes compiled code and embedded data; it is separate
from Odin's 8 MiB guest linear-memory maximum. The 10 MiB base PNG allowance includes
the cover, code and metadata. Larger modules can increase loading time and host
compilation memory without increasing guest memory or execution allowances.
Luau's 8 MiB allowance measures the complete bundled source, including SDK code,
wrappers and embedded graphics. Its executor starts with 4 MiB of linear memory
and allocates only the needed source buffer, growing up to a separate 64 MiB
ceiling for source, compiler and VM storage. The tracked Luau VM heap remains
capped at 4 MiB. Source size alone does not guarantee a game fits its heap or
execution budget. Native fuel and browser watchdog limits are unchanged.
The container and guest ABI are unchanged. Players with the earlier 1 MiB module
limit, 256 KiB Luau source limit and 2 MiB base PNG limit still load older cartridges, but reject files exceeding
those limits. Rebuild and distribute the updated native/browser player alongside
a larger cartridge.

Unsupported container, profile, SDK, ABI, language or flags fail explicitly.
These preview limits do not implement the proposed 128/512 MB full-ROM profile;
The optional `coNt` resource index provides bounded synchronous byte reads;
asynchronous streaming and the proposed full-ROM profiles remain later work.
Constants are recorded in [the SDK contract](../sdk/contract.json).

## Implementation and verification

[The Odin parser](../runtime/odin/cartridge/cartridge.odin) is shared by the native
player and the browser runtime Wasm module. Returned views borrow bounded input
storage; browser integration copies code before executing it. The native reader
checks file size before allocating; browser URL loading bounds streamed reads,
and local files are checked before reading. No game is executed before parsing.

Run `npm run test:cartridge` for both SDK languages, native/browser rendering and
audio parity, ordinary image decoding, default/custom covers, CLI output,
execution without loose payload files, local file/drop loading, executor cache
reuse, malformed PNGs and incompatible metadata. Verification output stays in
ignored `build/cartridge-verification/`. CI runs the same check.
