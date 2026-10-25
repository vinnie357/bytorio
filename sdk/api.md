# SDK API 0.2.0

This page documents lifecycle and drawing conveniences. SDK 0.2.0 also publishes
[resource ownership](resources.md), [explicit graphics](graphics.md),
[PCM audio](audio.md) and [synthesis/effects](synthesis.md). Both SDKs expose the
same [resource profile](../docs/resource-profile.md), including fixed limits and
compatibility checks before game initialization.

The current player also provides a bounded [persistent save slot](save.md)
through `byt.save` in Luau and `save "sdk:save"` in Odin.
Bounded [operating-system text entry](text-input.md) is available through
`byt.text_input` in Luau and `text "sdk:text"` in Odin, including phone keyboard focus.

Luau imports `local byt = require("@bytorio")`. Odin imports
`byt "sdk:bytorio"`. Sprite IDs start at zero. Drawing coordinates use the
current display. Colors are opaque packed u32 values, made with `rgb`.

| Operation                   | Luau                                     | Odin                                |
| --------------------------- | ---------------------------------------- | ----------------------------------- |
| Select display              | `byt.display(320,180)` or `(640,360)`    | `byt.display(.Low)` or `(.High)`    |
| Active dimensions           | `local w,h=byt.size()`                   | `w,h:=byt.size()`                   |
| Construct color             | `byt.rgb(r,g,b)`                         | `byt.rgb(r,g,b)`                    |
| Set persistent clear color  | `byt.clear(color)`                       | `byt.clear(color)`                  |
| Rectangle                   | `byt.rect(x,y,w,h,color)`                | `byt.rect(x,y,w,h,color)`           |
| Sprite, scale defaults to 1 | `byt.sprite(id,x,y,scale)`               | `byt.sprite(id,x,y,scale)`          |
| Sprite at pixel size        | `byt.sprite_size(id,x,y,w,h)`            | `byt.sprite_size(id,x,y,w,h)`       |
| ASCII text                  | `byt.text(value,x,y,color)`              | `byt.text(value,x,y,color)`         |
| Held button                 | `byt.button("left")`                     | `byt.button(.Left)`                 |
| Press/release edge          | `byt.pressed("action")`, `released`      | `byt.pressed(.Action)`, `released`  |
| Raw held mask               | `byt.buttons()`                          | `byt.buttons()`                     |
| Pointer snapshot            | `local active,x,y=byt.pointer()`         | `active,x,y:=byt.pointer()`         |
| Pointer hover snapshot      | `local hover,x,y=byt.pointer_position()` | `hover,x,y:=byt.pointer_position()` |
| Wheel direction this tick   | `byt.wheel()`                            | `byt.wheel()`                       |
| Full held mask              | `byt.all_buttons()`                      | `byt.all_buttons()`                 |
| Current tick                | `byt.ticks()`                            | `byt.ticks()`                       |
| Request sound cue           | `byt.sound()`                            | `byt.sound()`                       |
| Set deterministic seed      | `byt.seed(value)`                        | `byt.seed(value)`                   |
| Next random u32             | `byt.random_u32()`                       | `byt.random_u32()`                  |
| Development position        | `byt.debug_position(x,y)`                | `byt.debug_position(x,y)`           |

Buttons are left/right/up/down/action in Luau, `.Left/.Right/.Up/.Down/.Action`
in Odin. `pressed` and `released` are stable throughout a tick and its draws;
querying them does not consume an event. Inactive pointers return false,0,0.
The [extended input contract](README.md#direction-and-camera-input) adds mouse
buttons, hover, wheel and gameplay keys. `buttons()` remains the original five
bits; use `all_buttons()` for the full unsigned 32-bit mask. A gamepad sends
existing bits (B is `escape`, Start is `map`, shoulders are `rotate_*`); see
[Gamepad](README.md#gamepad).
`debug_position` is an optional pair of numbers for replay tools, bounded to ±4096;
it does not move sprites or alter simulation. The version strings are Luau's
`byt.version` and Odin's `byt.VERSION`.

The build tool supplies the immutable atlas. Advanced Lua bundlers can call
`byt.assets(base64Packet)` only during module loading or initialization.
Odin entry generators pass a stable `[]u8` packet to `byt.start`; that memory
must remain valid throughout cartridge execution. The `_wrap` Luau function and
Odin lifecycle exports are SDK integration details, not game callbacks.

Rectangles accept dimensions 0..4096. Sprite integer scales are 1..8; sized sprites
are 1..128 pixels wide/high. Positions are ±4096; each text command is at most
1024 ASCII bytes. Luau fractional drawing coordinates truncate toward zero.
Both SDKs stop the cartridge on invalid arguments or frame-capacity exhaustion.
All limits, packet layouts, ordering and restart rules are defined in the
[cartridge specification](../docs/cartridge-spec.md).

The published resource profile supports custom PCM samples, mixer voices, streams
and synthesis through the [audio APIs](audio.md). 3D and compressed Ogg music
require their explicitly selected preview profiles; see the
[SDK feature guide](README.md). Cartridges have no arbitrary network or filesystem
access; use [indexed content](../docs/indexed-content.md) for packaged assets and
the [save API](save.md) for persistent progress.
