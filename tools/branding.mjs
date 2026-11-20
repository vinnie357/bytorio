import metadata from "../package.json" with { type: "json" };

// Package metadata owns the product identity. Runtime copies are generated.
export const branding = Object.freeze({
  name: metadata.displayName,
  command: Object.keys(metadata.bin)[0],
  website: metadata.homepage,
  playerTitle: `${metadata.displayName} player`,
  gameTitle: `${metadata.displayName} game`,
  starterTitle: `Hello, ${metadata.displayName}!`,
  starterMessage: `HELLO, ${metadata.displayName.toUpperCase()}!`,
});
