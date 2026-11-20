# Embedding the web player

Copy the SDK's complete web player directory, or your `byt build` web export, to
your site. Import the player module and mount it into any element:

```html
<div id="game"></div>
<script type="module">
  import { mountPlayer } from "./game/web-player.js";

  const player = mountPlayer(document.querySelector("#game"), {
    cartridge: "./game/game.png",
    title: "My game",
    instructions: "Arrows / WASD move. Space jumps.",
    controls: {
      preset: "dpad",
      overrides: { action: { label: "Jump", symbol: "A", bindings: ["action"] } },
    },
  });
  await player.ready;
  // player.runtime supplies lifecycle, input and events for your own controls.
  // Await player.dispose() when removing the player or navigating away.
</script>
```

The compact toolbar supplies Play/Pause, Mute, Fullscreen, and a menu for Restart
and Open cartridge. Loading, errors and retry stay inside the mount. Styles are
scoped to the player. `diagnostics: true` adds a separate collapsible diagnostics
panel; it is off by default. Audio starts from a Play gesture.

`mountPlayer(element, options)` returns `{ runtime, ready, load, dispose, element }`.
`ready` rejects on initial load failure and the player displays the error.
`load(...)` and `runtime.on(...)` use the [public runtime](web-runtime.md) API.
Dispose the mount before reusing its host element. Multiple mounts are independent.
Omit `cartridge` to begin idle, then choose Open cartridge from the menu. The
standalone `player.html?local` page provides the same mode, even if a game URL or
generated cartridge is configured.

`toolbar: false` lets you supply your own toolbar through `player.runtime`.
`controls: { preset: "none", pointer: false }` disables the built-in game-surface
pointer and on-screen buttons, leaving your own input adapters available.
For an entirely custom player, import `runtime.js` directly. Worker messages and
development-page globals are internal.

## On-screen controls

Controls default to `dpad`: four directions plus Action. Directional buttons bind
both classic directions and extended movement bindings. Keyboard arrows also
expose pan bindings; WASD exposes movement bindings. Space is Action. The standard
gamepad D-pad/A button works while the game canvas owns focus.
M opens the map binding; Tab navigates the player controls. Set `keyboard: false`
or `gamepad: false` under `controls` to replace either adapter yourself. Custom
input source names should be distinct from those owned by other adapters.

`visibility` is `"auto"` (touch/coarse-pointer devices), `"always"`, or `"never"`.
The `pointer` preset supplies tap/drag without buttons. `pointer: false` disables
tap/drag for any preset. Analog sticks and gestures are outside this release.
Buttons support simultaneous contacts, held directions plus actions, cancellation
and independent keyboard/touch holds. Canvas coordinates scale to the game's
logical resolution. Blur, hidden pages, pause, reload and disposal release input.
Fullscreen contains the game, toolbar and touch controls.

Use `overrides` keyed by preset ID (`up`, `left`, `down`, `right`, `action`) to
change `label`, `symbol`, `bindings` or layout. Or supply a complete `layout`:

```js
controls: {
  visibility: "always",
  layout: [
    { id: "bag", label: "Inventory", symbol: "Bag", bindings: ["inventory"],
      column: 1, row: 1, columns: 2, rows: 1 },
    { id: "use", label: "Use item", symbol: "Use", bindings: ["action"],
      column: 11, row: 1, columns: 2, rows: 1 },
  ],
}
```

Layouts use 12 columns and up to four rows, with one-based coordinates. Each
button defaults to two columns and one row. Up to 32 unique control IDs are
supported. Binding names come from the shared input schema; misspellings and
invalid layouts fail immediately. Choose readable labels and large touch targets.

## Styling and hosting

Set the host's width; the game keeps its aspect ratio. Styles live in a shadow
root. Customize inherited `--byt-background`, `--byt-border`, `--byt-color` and
`--byt-accent`. The returned `element` exposes shadow parts `player`, `viewport`,
`canvas`, `toolbar` and `controls`. Include `viewport-fit=cover` in the viewport
meta tag on mobile sites. Fullscreen accounts for safe-area insets.

Keep module assets together: Workers, Wasm, audio worklet, decoder and shaders.
Serve JavaScript and Wasm with suitable MIME types. Your host's CSP must permit
same-origin module Workers, scripts and Wasm; a strict style policy may need to
permit the scoped inline stylesheet. The guest does not gain arbitrary DOM or
network access. Keep the SDK version pinned with the game and test on your
supported physical devices and browsers.
