export const games = [
  {
    id: "copper-circuit",
    title: "Copper Circuit",
    category: "Arcade racing",
    description:
      "Six rivals. Three laps. One well-timed boost. Take the racing line through a winding, sprite-built circuit.",
    detail:
      "Accelerate into a three-lap race, manage your rechargeable boost, and keep your kart on the road. Cross the finish line, then press Boost to race again.",
    build: "examples/racing/build/player",
    cartridge: "racing",
    guide: "examples/racing/docs/racing-demo.md",
    resolution: "320 × 180",
    action: "Boost",
    controls: "↑ / W accelerate · ↓ / S brake · ← → / A D steer · Space boost / restart",
    requiresGpu: false,
    color: "orange",
  },
  {
    id: "mossglen",
    title: "Mossglen: The Sunleaf",
    category: "Tiny adventure",
    description:
      "A village, a missing sunleaf, and a slime in your way. A little quest with a whole lot of heart.",
    detail:
      "Find the healer by the red house, accept the quest, and cross the eastern bridge. Defeat the moss slime, collect the sunleaf, and bring it home. In battle, choose Attack, Guard, or a healing potion.",
    build: "examples/rpg/build/player",
    cartridge: "rpg",
    guide: "examples/rpg/docs/rpg-comparison.md",
    resolution: "640 × 360",
    action: "Confirm",
    controls: "Arrows / WASD move · Space talk / confirm · Arrows select in battle",
    requiresGpu: false,
    color: "green",
  },
];

export const sections = [
  [
    "Start here",
    [
      ["docs/getting-started.md", "Getting started"],
      ["sdk/README.md", "SDK & supported features"],
      ["GLOSSARY.md", "Glossary"],
    ],
  ],
  [
    "Build your game",
    [
      ["sdk/api.md", "API reference"],
      ["sdk/resources.md", "Resources"],
      ["sdk/graphics.md", "Graphics"],
      ["sdk/audio.md", "Audio"],
      ["sdk/synthesis.md", "Synthesis & effects"],
      ["sdk/save.md", "Save progress"],
      ["sdk/text-input.md", "Text input"],
      ["sdk/web-player.md", "Embed the web player"],
      ["sdk/web-runtime.md", "Build a custom player"],
      ["docs/native-player.md", "Native player"],
      ["docs/display-modes.md", "Display modes"],
      ["docs/png-cartridges.md", "PNG cartridges"],
    ],
  ],
  [
    "Advanced game features",
    [
      ["docs/frame-pacing.md", "Frame pacing"],
      ["docs/model-import.md", "Import models"],
      ["docs/indexed-content.md", "Packaged content"],
    ],
  ],
  [
    "For contributors",
    [
      ["docs/contributing.md", "Low-level documentation"],
      ["docs/development.md", "Build & test the console"],
      ["docs/language-examples.md", "Conformance examples"],
      ["docs/resource-profile.md", "Profile contracts"],
      ["docs/resource-av-spec.md", "Resource specification"],
      ["docs/cartridge-spec.md", "Legacy cartridge ABI"],
      ["docs/compact-3d.md", "3D renderer reference"],
    ],
  ],
];

// Publication is opt-in. Repository notes, ADRs and benchmark reports are not
// part of the game developer handbook, even when a public guide links to them.
export const publicDocuments = [
  ...sections.flatMap(([, links]) => links.map(([path]) => path)),
  ...games.map((game) => game.guide),
  "sdk/save.md",
  "sdk/text-input.md",
  "docs/3d-effects.md",
  "docs/billboards.md",
  "docs/indexed-content.md",
  "docs/resource-av-spec.md",
  "docs/textured-3d.md",
  "docs/mise-installation.md",
];
