# Explicit graphics: resource-av-1

The matching native and browser players implement the same Odin software
reference renderer. Luau uses `byt.gfx` and `byt.data`; Odin imports
`gfx "sdk:gfx"` and `data "sdk:data"`. The published SDK 0.2.0 / ABI 2
profile uses resource transport version 4, retaining the version-2 graphics layout.
The [resource ownership rules](resources.md) still apply.

## Resources and drawing

| Resource / operation | Luau | Odin |
| --- | --- | --- |
| Offscreen color/stencil | `gfx.target({format="rgba8",width=320,height=180,stencil=stencil})` | `gfx.target({format=.RGBA8,width=320,height=180,stencil=stencil})` |
| Attachment format | `"stencil8"` | `.Stencil8` |
| Reserved RGBA screen | `gfx.screen()` | `gfx.screen()` |
| Palette | `gfx.palette(colorsBuffer)` | `gfx.palette(colorsSlice)`; `[]u32` entries |
| Composition table | `gfx.color_table(bytes)` | `gfx.color_table(bytes)`; 65,536 u8 entries |
| Row table | `gfx.row_table(height)` | `gfx.row_table(height)` |
| Byte-range edit | `gfx.write(resource,offsetBytes,bytes)` | Same operation; `[]u8` |
| Typed row edit | `gfx.write_rows(table,firstRow,rows)` | Same operation; `[]gfx.Row` |
| Immutable pipeline | `gfx.pipeline(desc)` | `gfx.pipeline(desc)` |
| Default pipeline | `gfx.default_pipeline("rgba8")` | `gfx.default_pipeline(.RGBA8)` |
| Pass | `gfx.begin_pass(target,opts)`, `gfx.end_pass(pass)` | Same operations with typed structs |
| Bind pipeline | `gfx.bind(pass,pipeline)` | Same operation |
| Clip | `gfx.clip(pass,x,y,w,h)` | Same operation; signed integer coordinates |
| Affine transform | `gfx.transform(pass,{a,b,c,d,tx,ty})` | Same operation; `[6]f64` |
| Solid rectangle | `gfx.rect(pass,x,y,w,h,color)` | Same operation |
| Quad | `gfx.draw(pass,image,sourceRect,destRect,opts)` | Source `gfx.Source_Rect`, destination `gfx.Quad` |
| Clear attachments | `gfx.clear(pass,color,clearStencil,value)` | Same operation |
| Outside-pass copy | `gfx.copy(source,dest,sourceRect,x,y)` | Same operation; distinct, equally formatted images |
| Presentation | `gfx.present(image,opts)` | Same operation |
| Submission readback | `gfx.readback(image,rect)` | Returns a typed `gfx.Readback` |
| Consume result | `gfx.poll(ticket)` returns buffer or nil | Returns `(data.Pixel_Buffer,bool)` |
| Free | `gfx.destroy(resource)` | Same operation, with resource-specific types |

Create resources and upload/edit their data in init/update. Draw records passes,
copies, readbacks and one presentation. All commands preserve order. `Texture`
and `Target` are distinct types; either can be sampled, presented, copied or read
back. A pass requires a color `Target`. `stencil8` is attachment-only: it can be
uploaded/copied but cannot be sampled as color or presented. A color target's
optional stencil target must have matching dimensions. There are eight user
targets total, including stencil attachments, plus the reserved screen.

The reserved screen is RGBA8 and follows the active 320x180 or 640x360 mode.
Its first use after resize starts with zero storage. Offscreen images retain
their dimensions and contents. Upload into user textures/targets; direct CPU
uploads into the reserved screen are not supported. A display switch changes
the next presentation; the pointer snapshot for the current update retains the
previous display's bounds in both SDKs.

For a pass, `opts` contains `pipeline`, `clear`, `color`, `clear_stencil` and
`stencil` (clear value). Omitted pipeline uses replace with all color bits enabled;
clip covers the target and transform is identity. Every pass starts fresh.
Clears cover the whole attachment independently of clip, transform or write mask.
Uncleared contents persist. Passes cannot nest, cross callbacks or be reused
after `end_pass`.

## Pipeline controls

Pipeline descriptors select `format`, `blend`, `color_table`, `write_mask`,
`transparent_index` and a `stencil` descriptor. Luau blend tags are `"replace"`,
`"over"`, `"add"`, `"table"`; Odin uses `.Replace`, `.Over`, `.Add`, `.Table`.

- Index8 supports replace or table lookup. Composition uses
  `table[sourceIndex*256 + destinationIndex]`, then applies the eight-bit write
  mask. Every index 0..255 is usable. An optional transparent source index
  discards that fragment before stencil or color writes, including indexed-to-RGBA
  draws. A rectangle in an indexed pass takes an index as its color.
- RGBA8 supports replace, premultiplied source-over and saturating add. Its
  `write_mask` uses bit 0=R, 1=G, 2=B, 3=A. All channels are enabled by default.
  Masked results must remain premultiplied; otherwise the packet fails.
- Stencil has `compare` (`"always"`, `"equal"`, `"not_equal"` / `.Always`,
  `.Equal`, `.Not_Equal`), `reference`, `read_mask`, `write_mask`, `replace_pass`
  and `replace_fail`. Reference defaults to zero and masks to 255. Comparisons
  mask both stored and reference values. Replacements preserve unwritable bits.
  Nontrivial stencil behavior requires an attached stencil image.

Odin optional numeric fields use `gfx.Optional_U32`, a `union {u32}`. Omission
selects the default; explicit values include zero, for example
`write_mask=u32(0)` for stencil-only drawing or `transparent_index=u32(0)`.
The same rule applies to draw tint, stencil masks and presentation background.
Luau uses optional number fields, where nil selects the default.

`gfx.rgba(r,g,b,a)` takes ordinary byte channels and premultiplies RGB with
`(channel*alpha+127)/255`. Raw pixel/palette storage is R/G/B/A bytes, with every
RGB byte at most alpha. Color math operates in encoded byte space. Source-over
uses `src + round(dst*(255-srcAlpha)/255)` per channel, saturating to 255;
add clamps each summed channel. With denominator 255, integer `+127` implements
nearest rounding without half ties. No implicit gamma conversion occurs.

Palettes contain 256 premultiplied RGBA entries. Indexed-to-RGBA drawing requires
an explicit palette; RGBA-to-index conversion is rejected. In indexed-to-index
drawing the indices remain indices. Quad options are `palette`, premultiplied
`tint` (default white), `flip_x`, `flip_y`, and `repeat_image` (default clamp).
An indexed pass cannot apply an RGBA tint. Transparent RGBA pixels participate
normally in the chosen blend operation; transparency is not an implicit discard.

Transforms map `(x,y)` to `(a*x+c*y+tx,b*x+d*y+ty)`. SDK coordinates quantize to
signed 16.16 with `floor(value*65536+0.5)`; coefficients are bounded to +/-16,
translations and explicit primitive coordinates to +/-4096. Singular transforms
fail. The software reference tests target pixel centers `(x+0.5,y+0.5)` against
the inverse-transformed, half-open local rectangle. Nearest sampling uses floor
of the mapped source coordinate, then explicit clamp/repeat. Reflections retain
the same local-edge inclusion rule; coverage is not changed to fit screen winding.
Source rectangles use integer texels. Clip rectangles use half-open integer bounds.

Sampling the active target is rejected. Use separate targets and an outside-pass
copy for feedback effects; copies require equal formats, fitting rectangles and
distinct storage. The reference enforces 16,777,216 units of pixel work per draw
packet across clipped raster bounds, clears, copies and presentation. Readback
copies have their own count/byte limits. These are prototype limits, not a promise
that every maximum workload fits a frame on every device.

## Presentation and readback

A nonempty graphics draw packet must end its passes and contain exactly one
`present`. Empty packets preserve the old-profile drawing path. Presentation
dimensions must exactly match the active display. RGBA output flattens over an
opaque background, default black. Indexed output supplies `palette` or `rows`.
Each row is `{palette,x,y}`: a live palette plus signed integer source offsets.
The row count must equal display height. `repeat_image` selects wrap rather than
clamp. Row tables retain their palette dependencies; pipelines retain their
composition tables and targets their stencil attachments. Destroy dependants
before their referenced resources.

Readback is outside passes and copies the requested submission immediately on
the CPU reference, including its ordering relative to later commands. Delivery
is deferred until a subsequent update, through a versioned mailbox. There are
four outstanding tickets, at most 1 MiB each, with at most 1 MiB result payload
delivered per update. Excess ready results stay budgeted on the host. Polling a
ready ticket transfers a tightly packed pixel buffer to the game and consumes
the ticket. Pending polls return nil/false. Destroy cancels a ticket and frees any
unconsumed SDK result. Game-owned result buffers still count against guest memory;
use Odin's `data.free_pixels` when finished. Results must fit the game's remaining
heap even when the host has room for more outstanding tickets.

`data.get_pixel`, `set_pixel`, `fill_pixels` and `copy_pixels` provide checked
CPU operations in both SDKs. Pixel copy handles overlapping rows. Odin also
exposes typed byte slices; Luau exposes the buffer library. Games producing CPU
effects can keep their own buffers instead of reading back rendered surfaces.

## Compatibility and validation

Inside an explicit pass, `byt.rect`, `sprite`, `sprite_size`, `text` and
`clear` emit ordered graphics commands and obey that pass's state. Sprite/font
assets still come from the current SDK importer. The immutable atlas contains
RGBA colors, so sprite convenience drawing requires an RGBA target; use indexed
textures for an indexed pass. `gfx.text` also accepts an index in an indexed pass.
Outside explicit passes the old-profile convenience path remains available.
An explicit presentation selects the entire final image; outside-pass legacy
commands do not add another layer. Put conveniences inside the pass they should
compose with.
No accelerated graphics adapter is enabled by this milestone.

Control and draw packets share a session/sequence stream, while only updates
advance simulation ticks. Hosts cache the negotiated transport version, validate
all required version-2 mailbox exports before init, and do not accept graphics
operations under version 1. Every draw packet validates and allocates private
target/stencil/output versions before publication. Errors retain the prior
resources and presentation; session failure then tears down host resources.
No partially rendered frame reaches the display.

The version-2 native Odin guest allowance is 100 million Wasmtime fuel units per
call to cover bounded full-frame serialization; old version-1/no-resource guests
retain 10 million, and Luau retains its existing 500 million allowance. Fuel is
not a millisecond guarantee. The resource quota remains 64 MiB, guest memory
32 MiB, and tracked Luau heap 8 MiB. Pending readbacks, screen/output storage,
transaction snapshots and old/new versions are charged to the resource quota.

Run `npm run test:graphics`. The equivalent
[Luau cartridge](../examples/resources/graphics/luau/main.luau) and
[Odin cartridge](../examples/resources/graphics/odin/main.odin) exercise all these paths.
The verifier compares complete pixel buffers for 13 frames per language on
native and browser, tests failure/reload and pointer/mode transitions, checks
independent reference pixels with allocation tracking, and measures a full-frame
upload. It writes raw captures, `composition.png` and `report.json` beneath the
ignored `build/graphics-verification/`. [Measurement notes](../docs/internal/measurements/graphics-measurements.md)
describe what the timings and copy counters include.
