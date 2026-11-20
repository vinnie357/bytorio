# Frame pacing

Design rationale: [simulation independent of render cadence](adr/0009-separate-simulation-from-render-cadence.md).

Both Luau and Odin cartridges use the same three player policies:

| Policy | Behavior |
| --- | --- |
| Capped | Render up to a custom integer rate from 1–240 FPS. Defaults to 60. |
| Uncapped | Start another draw as soon as the previous frame has been delivered. Native requests VSync off. |
| Native | Follow browser animation frames or native VSync at the display's refresh rate. |

The development browser host (`debug.html`) exposes a policy selector and numeric
FPS cap. The production host keeps that tuning out of its compact toolbar.
Embeds can call `player.runtime.setFrameRate(...)` without restarting the game.
Both hosts accept URL settings `?fps=60`, `?fps=144`,
`?fps=uncapped`, or `?fps=native`. The default is always a 60 FPS cap when no
setting is supplied. The URL retains the selection for reloads and sharing.

The standalone player accepts the corresponding `--fps 60`, `--fps 144`,
`--fps uncapped`, and `--fps native` arguments. The SDK launcher supports them:

```sh
byt run my-game --target native -- --fps uncapped
byt run my-game
```

For browser play, add `?fps=native` or another policy to the printed player URL,
or use the development host's controls. These are
host launch preferences, not new cartridge metadata or a game-side SDK API.
Players opening an ordinary cartridge retain the default unless configured.

## Simulation and presentation

Simulation always advances at 60 Hz, with at most five catch-up updates per
request. Draw can run multiple times between updates, or after multiple updates.
Drawing does not advance game time, input edges or scheduled audio. Keep gameplay,
random choices and audio triggers in `update`, rather than `draw`.

Higher render rates do not automatically interpolate a game's 60 Hz movement.
The current ABI supplies no fractional render-time interpolation parameter;
that is a separate extension. Native mode matches display opportunities, not a
promise that a heavy game can achieve that rate. Uncapped browser rendering remains
subject to Worker transfers, browser scheduling and compositor limits: rendered
FPS can exceed the number of distinct frames physically displayed. Native driver
settings can also override the requested VSync behavior.

Pause and resume reset the scheduling clock without advancing game time. Smoke,
check and replay modes deliberately bypass real-time render pacing so their
fixed-tick results remain independent of the selected policy.

## GPU supersampling

The prototype and console browser GPU paths use WebGL 2. The standalone console
uses OpenGL. Wasm runs game and host logic while the GPU executes mesh shaders,
supersampling and filtered presentation. Both SDKs can select up-to-1080p SSAA
with camera snapping and smooth panning; resident meshes are independently opt-in.
GPU acceleration remains optional and CPU remains the default backend.

For example, append `&fps=native` or `&fps=uncapped` to a browser launch with
`?renderer=gpu&ssaa=1080p&pixel-snap&smooth-pan&gpu-meshes`.
See [the measured pipeline limits](../experiments/voxel-resolution/docs/riverside-console-measurements.md): matching
GPU capabilities does not imply identical overhead or guarantee 60 FPS on every
device.
