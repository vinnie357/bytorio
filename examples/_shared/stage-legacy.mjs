import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { encodeCartridge } from "../../tools/sdk/cartridge.mjs";
import { exportPlayer } from "../../tools/player-export.mjs";
const root = process.argv[2] || "examples/rpg/build/player";
const racing = process.argv[3] === "racing";
const cartridge = racing ? "racing" : "rpg";
const assets = JSON.parse(
  await readFile(
    racing ? "examples/racing/build/assets/cover-assets.json" : "examples/rpg/shared/assets.json",
    "utf8",
  ),
);
const cartridges = {};
for (const language of ["luau", "odin"]) {
  cartridges[language] = encodeCartridge({
    title: assets.title || "Mossglen: The Sunleaf",
    language,
    display: racing ? [320, 180] : [640, 360],
    assets,
    code: await readFile(
      language === "luau"
        ? `examples/${cartridge}/build/assets/${racing ? "racing" : "batched"}.luau`
        : `examples/${cartridge}/build/odin/web/game.wasm`,
    ),
  });
}
for (const platform of ["web", "native"]) {
  const target = `${root}/${platform}`,
    source = `examples/${cartridge}/build/odin/${platform}`;
  await mkdir(`${target}/licenses`, { recursive: true });
  for (const language of ["luau", "odin"]) {
    await writeFile(`${target}/${cartridge}-${language}.png`, cartridges[language]);
  }
  await exportPlayer({ platform, source, target, luau: true });
  await copyFile(`${source}/game.wasm`, `${target}/game.wasm`);
  await copyFile(
    racing ? "examples/racing/build/assets/racing.luau" : "examples/rpg/build/assets/batched.luau",
    `${target}/${cartridge}.luau`,
  );
}
const html = await readFile(`${root}/web/player.html`, "utf8");
await writeFile(
  `${root}/web/player.html`,
  html.replace("</main>", '<p><a href="./comparison.html">Choose cartridge</a></p></main>'),
);
await writeFile(
  `${root}/web/player-config.json`,
  JSON.stringify(
    {
      instructions: racing
        ? "Arrows / WASD steer, accelerate and brake. Space boosts."
        : "Arrows / WASD move. Space talks and confirms.",
      controls: {
        visibility: "always",
        overrides: { action: { label: racing ? "Boost" : "Confirm" } },
      },
    },
    null,
    2,
  ),
);
const launcher = await readFile(`examples/${cartridge}/shared/launcher.html`, "utf8");
await writeFile(`${root}/web/comparison.html`, launcher);
console.log(`Unified prototype staged in ${root}.`);
