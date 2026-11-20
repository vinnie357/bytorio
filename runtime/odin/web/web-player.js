import { createRuntime } from "./runtime.js";
import { normalizePlayerConfig } from "./player-config.js";
import { attachPlayerInput } from "./player-input.js";

const mounts = new WeakSet();
const styles = `
:host {display:block; color-scheme:dark; color:var(--byt-color,#e9edf3); font:14px/1.4 system-ui,sans-serif; --accent:var(--byt-accent,#80dac3)}
* {box-sizing:border-box}
.player {width:100%; margin:auto; border:1px solid var(--byt-border,#394251); border-radius:14px; overflow:hidden; background:var(--byt-background,#161c27)}
.viewport {position:relative; display:grid; place-items:center; background:#080b12; padding:8px; overflow:hidden}
canvas {display:block; width:100%; height:auto; max-width:100%; image-rendering:pixelated; touch-action:none; outline:none; background:#080b12}
canvas:focus-visible {outline:2px solid var(--accent); outline-offset:-2px}
.toolbar {display:flex; gap:6px; align-items:center; flex-wrap:wrap; padding:8px 10px; border-top:1px solid var(--byt-border,#394251)}
.title {flex:1; min-width:5rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; padding:0 6px}
button,summary {font:inherit; color:inherit; border:1px solid transparent; border-radius:7px; background:transparent; cursor:pointer; min-height:44px; padding:8px 12px}
button:hover,summary:hover {background:#ffffff12}
button:focus-visible,summary:focus-visible {outline:2px solid var(--accent); outline-offset:-2px}
button:disabled {opacity:.45; cursor:default}
.play {background:var(--accent); color:#101d20; font-weight:650; min-width:84px}
.play:hover {filter:brightness(1.08); background:var(--accent)}
[hidden] {display:none!important}
.menu {position:relative}
.menu summary {list-style:none; display:grid; place-items:center}
.menu summary::-webkit-details-marker {display:none}
.menu-items {position:absolute; z-index:5; right:0; bottom:100%; min-width:190px; background:#202837; border:1px solid #465266; padding:6px; border-radius:10px; box-shadow:0 8px 25px #0008}
.menu-items button {display:block; width:100%; text-align:left}
.status,.instructions {margin:0; padding:0 16px 10px; color:#abb9ca; overflow-wrap:anywhere}
.status:empty,.instructions:empty {display:none}
.status[data-error] {color:#ffb4ab}
.touch-controls {display:grid; grid-template-columns:repeat(12,minmax(0,1fr)); grid-auto-rows:48px; gap:5px; padding:10px 12px; touch-action:none; user-select:none; -webkit-user-select:none; -webkit-touch-callout:none}
.touch-key {border:1px solid var(--byt-border,#526078); background:#273247; padding:0 4px; min-height:44px; min-width:0; font-size:20px; touch-action:none}
.touch-key[data-control=action] {border-color:var(--accent); color:var(--accent)}
.touch-key.pressed,.touch-key:active {background:var(--accent); color:#101d20}
.diagnostics {margin:0 10px 10px; color:#abb9ca}
pre {overflow:auto; max-height:200px; font-size:12px}
.player:fullscreen {width:100%; height:100%; border:0; border-radius:0; display:flex; flex-direction:column; justify-content:center; padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
.player:fullscreen .viewport {flex:1; min-height:0}
.player:fullscreen canvas {width:auto; max-height:100%; object-fit:contain}
.player:fullscreen .touch-controls {width:100%; max-width:720px; align-self:center}
@media(max-width:480px) {.toolbar {gap:0; padding:4px}.toolbar button {padding:8px}.title {font-size:12px}.viewport {padding:4px}}
@media(prefers-reduced-motion:no-preference) {button {transition:background-color .1s}}
`;

// UI state and DOM belong to this mount; game execution is exclusively public runtime calls.
export function mountPlayer(
  element,
  {
    cartridge,
    title,
    instructions,
    controls,
    diagnostics = false,
    toolbar = true,
    graphics,
    frameRate = 60,
    audioContext,
  } = {},
) {
  if (!element || typeof element.append !== "function" || mounts.has(element)) {
    throw new TypeError("Supply an unmounted host element");
  }
  if (typeof toolbar !== "boolean") {
    throw new TypeError("Toolbar must be boolean");
  }
  const config = normalizePlayerConfig({
    ...(title === undefined ? {} : { title }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(controls === undefined ? {} : { controls }),
    diagnostics,
  });
  const document = element.ownerDocument;
  const container = document.createElement("div");
  const root = container.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${styles}</style>
<section class="player" part="player" aria-label="Game player">
  <div class="viewport" part="viewport"><canvas width="640" height="360" tabindex="0" aria-label="Game display" part="canvas"></canvas></div>
  <div class="touch-controls" part="controls" role="group" aria-label="On-screen controls"></div>
  <div class="toolbar" part="toolbar" role="group" aria-label="Playback controls">
    <button class="play" type="button">Play</button><span class="title"></span>
    <button class="mute" type="button" aria-pressed="false">Mute</button>
    <button class="fullscreen" type="button">Fullscreen</button>
    <details class="menu"><summary aria-label="More player options">•••</summary><div class="menu-items">
      <button class="restart" type="button">Restart game</button><button class="open" type="button">Open cartridge…</button>
    </div></details>
  </div>
  <p class="status" role="status" aria-live="polite"></p><p class="instructions"></p>
  <input class="file" type="file" accept=".png,image/png" hidden>
  <details class="diagnostics"><summary>Diagnostics</summary><pre></pre></details>
</section>`;
  const find = (selector) => root.querySelector(selector);
  const canvas = find("canvas");
  const region = find(".player");
  const touch = find(".touch-controls");
  const status = find(".status");
  const play = find(".play");
  const mute = find(".mute");
  const fullscreen = find(".fullscreen");
  const details = find(".diagnostics");
  find(".toolbar").hidden = !toolbar;
  find(".instructions").textContent = config.instructions;
  details.hidden = !config.diagnostics;
  fullscreen.hidden = !region.requestFullscreen;
  for (const item of config.controls.layout) {
    const control = document.createElement("button");
    control.type = "button";
    control.className = "touch-key";
    control.dataset.control = item.id;
    control.textContent = item.symbol;
    control.setAttribute("aria-label", item.label);
    control.setAttribute("aria-pressed", "false");
    control.style.gridColumn = `${item.column} / span ${item.columns}`;
    control.style.gridRow = `${item.row} / span ${item.rows}`;
    touch.append(control);
  }
  element.append(container);
  let runtime;
  try {
    runtime = createRuntime({
      canvas,
      graphics,
      frameRate,
      diagnostics: config.diagnostics,
      audioContext,
    });
  } catch (error) {
    container.remove();
    throw error;
  }
  mounts.add(element);
  const detachInput = attachPlayerInput({
    runtime,
    canvas,
    controls: touch,
    config: config.controls,
  });
  const abort = new AbortController();
  const signal = abort.signal;
  const listen = (element, name, callback) => element.addEventListener(name, callback, { signal });
  let disposed = false;
  let disposal;
  function showError(error) {
    if (disposed || error.name === "AbortError") {
      return;
    }
    status.textContent = error.message || String(error);
    status.dataset.error = "true";
  }
  function reflect(state) {
    const loading = state.state === "loading";
    const failed = state.state === "failed";
    play.disabled = loading || (!state.ready && !failed);
    play.textContent = loading
      ? "Loading…"
      : failed
        ? "Retry"
        : state.state === "running"
          ? "Pause"
          : "Play";
    play.setAttribute(
      "aria-label",
      failed ? "Retry game" : state.state === "running" ? "Pause game" : "Play game",
    );
    find(".title").textContent = title ?? state.title ?? config.title;
    find(".restart").disabled = !state.ready;
    mute.setAttribute("aria-pressed", String(state.audio.muted));
    mute.textContent = state.audio.muted ? "Unmute" : "Mute";
    status.toggleAttribute("data-error", failed);
    status.textContent = failed
      ? state.error
      : loading
        ? "Loading game…"
        : state.state === "paused"
          ? "Paused"
          : state.state === "idle"
            ? "Open a PNG cartridge to begin."
            : "";
    canvas.style.imageRendering = state.smoothPresentation ? "auto" : "pixelated";
    if (config.diagnostics && details.open) {
      find("pre").textContent = JSON.stringify(
        {
          state: state.state,
          ticks: state.ticks,
          renderedTicks: state.renderedTicks,
          graphics: state.graphics,
          metrics: state.metrics,
          audio: state.audio,
        },
        null,
        2,
      );
    }
  }
  const unsubscribers = [
    runtime.on("state", reflect),
    runtime.on("frame", reflect),
    runtime.on("error", reflect),
    runtime.on("audio", reflect),
    runtime.on("progress", (state) => {
      const { received, total } = state.progress;
      status.textContent = total
        ? `Loading game… ${Math.floor((received * 100) / total)}%`
        : `Loading game… ${(received / 1048576).toFixed(1)} MiB`;
    }),
  ];
  reflect(runtime.getSnapshot());
  listen(play, "click", () => {
    if (runtime.state === "running") {
      runtime.pause();
    } else if (runtime.state === "failed") {
      runtime
        .restart()
        .then(() => runtime.play())
        .catch(showError);
    } else {
      runtime
        .play()
        .then(() => {
          if (!runtime.getSnapshot().textEditing) {
            canvas.focus({ preventScroll: true });
          }
        })
        .catch(showError);
    }
  });
  listen(mute, "click", () => runtime.setMuted(!runtime.getSnapshot().audio.muted));
  listen(fullscreen, "click", () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(showError);
    } else {
      region.requestFullscreen().catch(showError);
    }
  });
  listen(document, "fullscreenchange", () => {
    fullscreen.textContent = root.fullscreenElement ? "Exit fullscreen" : "Fullscreen";
  });
  listen(find(".restart"), "click", () => {
    find(".menu").open = false;
    runtime.restart().catch(showError);
  });
  listen(find(".open"), "click", () => {
    find(".menu").open = false;
    find(".file").click();
  });
  listen(find(".file"), "change", (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (file) {
      runtime.load(file).catch(showError);
    }
  });
  listen(region, "dragover", (event) => event.preventDefault());
  listen(region, "drop", (event) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) {
      runtime.load(file).catch(showError);
    }
  });
  const ready =
    cartridge === undefined ? Promise.resolve(runtime.getSnapshot()) : runtime.load(cartridge);
  // A mount shows failures itself; callers can also await/catch its ready promise.
  ready.catch(showError);
  return Object.freeze({
    runtime,
    element: container,
    ready,
    load: (...args) => runtime.load(...args),
    dispose() {
      if (disposal) {
        return disposal;
      }
      disposed = true;
      abort.abort();
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
      detachInput();
      disposal = runtime.dispose().finally(() => {
        container.remove();
        mounts.delete(element);
      });
      return disposal;
    },
  });
}
