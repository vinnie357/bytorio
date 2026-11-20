# Browser runtime

The SDK's `runtime.js` module runs a cartridge in a caller-supplied canvas. It
does not create a toolbar, install keyboard listeners, or style the page. The
default player uses this same execution layer. Serve the SDK's complete web
directory over HTTP(S); keep its relative files together. Assets resolve beside
the module, while cartridge URLs resolve against the embedding document. Game
URLs must share the host origin. The guest's import and resource sandbox still
applies.

## Try the complete custom player

Current SDK previews include `custom-player.html` and `custom-player.js`
in every web export. Older SDK pins keep their previous files; run
`byt sdk upgrade` explicitly to select the newest compatible SDK. From your game directory:

```sh
byt run --no-open
```

Keep that terminal running. Use the host and port from the printed Player URL
and open `/custom-player.html`. For example, if the CLI prints
`http://127.0.0.1:54321/`, open
`http://127.0.0.1:54321/custom-player.html`. This uses `run`, the one-shot build
and server; the custom example does not install `dev`'s automatic reload client.
Choose Play, then use arrows/WASD, Space, the Action button, or tap/drag the canvas.
The example supplies its own keyboard/pointer adapters, Play/Pause, Mute, Restart,
PNG file loading, error feedback and asynchronous disposal. It imports only
`runtime.js`; the stock shell and its bootstrap are not required.

The exported layout is:

```text
build/web/
  custom-player.html    # editable page, canvas, styles and controls
  custom-player.js      # runtime-only host and input adapters
  game.png
  runtime.js
  session.js
  worker.js
  runtime.wasm
  runtime-gpu.wasm
  audio.wasm
  ...                  # keep ALL remaining export files and subdirectories
```

Copy the **whole** `build/web/` directory into your website before customizing
the two example files. Do not edit them inside `build/`, where the next web build
replaces them. They can be renamed to `index.html` and `player.js`; update the
HTML's script URL accordingly. Host your copy with static HTTP(S), serving Wasm
as `application/wasm`; `file:` URLs do not work. No Bytorio source checkout,
Node.js or framework is needed to deploy it. For an existing site, import
`createRuntime` from the copied runtime directory and supply your own canvas.
Keep the accompanying SDK files together; you need not load the stock-player
modules. The source pair also lives in `sdk/examples/custom-player/` inside the SDK's
core files; use the exported pair for its ready-to-serve filenames and dependencies.

## Minimal API example

```html
<canvas id="game" width="640" height="360"></canvas>
<button id="play">Play</button>
<script type="module">
  import { createRuntime } from "./sdk/web/runtime.js";

  const game = createRuntime({ canvas: document.querySelector("#game") });
  await game.load("./game.png");
  document.querySelector("#play").onclick = () => game.play();
  // Replace these calls with your own input adapter.
  game.setInput("custom-controls", { buttons: ["right", "action"] });
  game.setInput("custom-controls", null);
  // Await game.dispose() before removing/reusing the canvas.
</script>
```

Use the complete example above for error handling and listener cleanup.

## Input and lifecycle

Held input is sampled on simulation updates. A synthetic keydown/keyup pair
entirely between updates can be missed; rendering more often does not change the
60 Hz simulation. In browser tests, hold keys until an observed simulation update
has consumed them instead of sending an instantaneous `press()`.
For discrete UI activations or wheel events, use `pulseInput(["action"])` so the
binding reaches the next update. For continuous movement, use `setInput` on
keydown/up. Bind only while the game has focus, let Tab reach surrounding UI,
and respect `getSnapshot().textEditing` while the runtime's text editor is active.

Name independent sources, such as `keyboard` and `touch`: releasing one must not
release another. Convert pointer coordinates from the canvas's CSS bounds to
`getSnapshot().width` and `.height`, the logical game dimensions. Release held
input and pointer capture on cancellation, focus loss, pause and disposal.
The example demonstrates these adapters; it intentionally has no D-pad overlay.
Use the [stock player](web-player.md) for configurable mobile controls.

Await rejected operations in your own UI and show errors with a retry/open path.
Call `play()` from a user gesture for browser audio permissions. Blur/hidden-page
transitions pause the runtime; offer Play to resume. Before removing the host,
abort its DOM listeners and await `dispose()`; the runtime owns its own workers,
audio and event subscriptions, while your host owns its UI listeners.

## API reference

This is a preview API, versioned with the SDK and its matching players:

- `createRuntime({ canvas, frameRate = 60, graphics = {}, diagnostics = false,
  audioContext })` reserves one canvas per session. An optional caller-owned
  AudioContext is reused and never closed by the runtime. Otherwise a session
  creates its own context on `play()` and closes it on disposal.
- `load(url | File | Blob | ArrayBuffer | ArrayBufferView, { graphics }?)`
  resolves when the initial frame is ready. Byte inputs are PNG cartridges;
  `.luau` and `.wasm` URLs are also supported for development. Replacing a load
  rejects the superseded operation with `AbortError`. A failed load can be retried.
- `play()` starts/resumes execution and audio; call it from a user gesture.
  `pause()` releases inputs and silences this session. `restart()` reloads the
  selected cartridge and resumes if it was running. `unload()` returns to idle.
- `setInput(source, { buttons, pointer } | null)` replaces one named source.
  `buttons` is an array of schema binding names or a mask from exported `buttons`
  and `buttonMask()`. `pointer` has logical `x`, `y`, optional `down`, `right`,
  and `hover` booleans. Inputs are combined across at most 64 sources; pointer
  presses outside the logical image are ignored. `clearInput()` releases all.
- `setMuted(boolean)` controls this session's gain. `setFrameRate(number |
  "native" | "uncapped")` changes presentation cadence, preserving 60 Hz updates.
- `pulseInput(buttons)` queues bindings for the next simulation update, surviving
  presentation-only frames. Use it for wheel events or accessible button activation.
- `state` and `getSnapshot()` expose immutable state. `on(type, listener)` returns
  an unsubscribe function; events are `state`, `progress`, `frame`, `audio`, and
  `error`. Listeners receive snapshots. `ticks` is the latest simulation tick;
  `renderedTicks`, image dimensions and hash describe the last presented frame.
  Enable `diagnostics` when collecting frame hashes on the GPU path.
- `dispose()` is idempotent and asynchronous. It stops callbacks, releases input,
  DOM editing overlays, workers and audio, and allows pending save writes a bounded
  opportunity to settle. It does not dispose other sessions. Blur/hidden-page
  transitions pause playback; the host decides when to resume.

Save identity/storage, native browser text editing, packaged content, Ogg/audio
streaming and execution watchdogs use the same runtime contracts as the native
player. Handle rejected operations and render an error/retry UI in a custom host.
The Worker protocol, `session.js`, and development-page globals are internal.
