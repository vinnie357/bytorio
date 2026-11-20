import { mountPlayer } from "./web-player.js";

// This standalone page is one consumer of the embeddable module.
const parameters = new URLSearchParams(location.search);
const response = await fetch(new URL("./player-config.json", import.meta.url));
if (!response.ok && response.status !== 404) {
  throw new Error("Could not load player configuration");
}
const config = response.ok ? await response.json() : {};
const graphics = {};
if (parameters.has("renderer")) {
  graphics.backend = parameters.get("renderer");
}
if (parameters.has("ssaa")) {
  graphics.ssaa = parameters.get("ssaa");
}
for (const [parameter, name] of [
  ["pixel-snap", "pixelSnap"],
  ["smooth-pan", "smoothPan"],
  ["gpu-meshes", "residentMeshes"],
  ["surface-samples", "surfaceSamples"],
]) {
  if (parameters.has(parameter)) {
    graphics[name] = true;
  }
}
export const player = mountPlayer(document.querySelector("[data-bytorio-player]"), {
  ...config,
  cartridge: parameters.has("local")
    ? undefined
    : parameters.get("game") || config.cartridge || globalThis.playerCartridge || "./game.wasm",
  graphics,
  frameRate: parameters.get("fps") || 60,
});
player.runtime.on("frame", (state) => {
  if (state.title) {
    document.title = state.title;
  }
});
