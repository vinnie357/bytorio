# Bytorio

**A tiny console for big adventures.**

[Bytorio](https://bytor.io/) is a fantasy game console: a small game system made
in software. You can make your own games, play them on your computer or in a web
browser, and share them with friends. No special console hardware needed.

Think pixel-art adventures, arcade racers, little puzzles, and experiments that
start with “what if?” Bytorio focuses on 2D games, with experimental 3D tools to
explore when you're ready.

**[Play some games](https://bytor.io/showcase/)** ·
**[Get started](https://bytor.io/docs/docs/getting-started.html)** ·
**[Browse the docs](https://bytor.io/docs/)**

## Try it first

You don't need to install the development tools to play:

- **[Copper Circuit](https://bytor.io/showcase/copper-circuit/)** — race six
  rivals, find your line, and use your boost to reach the finish.
- **[Mossglen: The Sunleaf](https://bytor.io/showcase/mossglen/)** — explore a
  village, take on a quest, and battle a slime.

Choose **Load game**, then **Start game** to enable sound. Use your keyboard or
on-screen touch controls. Both games include Luau and Odin versions, so you can
see how the same idea works in either language.

## Make your first game

You don't need to understand how the console works inside to make a game for it.
Start small: move a character, change a color, or add a sound.

1. **Set up your tools.** Follow the [getting-started guide on the website](https://bytor.io/docs/docs/getting-started.html)
   or [read it in this repository](docs/getting-started.md).
2. **Create and run the starter game.** Follow [Create and run a game](docs/getting-started.md#create-and-run-a-game).
   `byt` is Bytorio's command-line tool: you type its commands into a terminal
   to create, check, and run a project.
3. **Make one small change.** Open the game in your code editor, change something,
   and run it again. [Make your first change](docs/getting-started.md#make-your-first-change)
   explains the starter's game callbacks.
4. **Build from there.** Try adding a goal, a new obstacle, or your own artwork.
   The [game examples](examples/README.md) are there to learn from.

**New to coding? Start with Luau**, the default language for new games. Odin is
also supported. Both languages can make games for the same console.

**Bytorio is still in development.** The [CLI preview for Windows and Mac](https://github.com/ctxshift/bytorio/releases)
creates, checks, builds and plays games using downloaded SDK tools and players.
No source checkout or contributor toolchain is required. Follow the [Mac install instructions](docs/getting-started.md#macos-apple-silicon-or-intel)
for Apple Silicon or Intel, or [install with mise](docs/getting-started.md#install-with-mise).
Luau/browser authoring supports Windows x64 and both Mac architectures; Odin and
native players support Windows and Apple Silicon.
You can play the browser demos without that setup.

For mise, add `"github:ctxshift/bytorio" = "byt-v<version>"` under `[tools]`,
using the full tag from your chosen CLI release. The
[mise quickstart](docs/getting-started.md#install-with-mise) covers installation and usage.

## Learn as you go

You can look things up as you need them:

- [Drawing and graphics](sdk/graphics.md) — put your game on the screen.
- [Audio](sdk/audio.md) — add sound effects and music.
- [Game API reference](sdk/api.md) — look up the tools available to your code.
- [Sharing your game](docs/png-cartridges.md) — package a game as a PNG cartridge:
  an image file that also contains the game. Share the original file, because
  resizing or re-saving it can remove the game data.
- [All documentation](https://bytor.io/docs/) — search for a topic or explore
  the full collection of guides.

## Work on the console itself

Want to help build Bytorio, or just curious about how it works? Start with the
[development guide](docs/development.md) for tool installation, builds, and tests.
The console runtime uses Odin; games can use **Luau or Odin**.

The deeper details live in their own guides:

- [Architecture](docs/architecture.md) and [implementation plan](docs/implementation-plan.md).
- [Supported features and limits](docs/resource-profile.md), [display modes](docs/display-modes.md),
  and the [cartridge specification](docs/cartridge-spec.md).
- [Experimental 3D](docs/compact-3d.md) and [model importing](docs/model-import.md).
- [Website development and deployment](docs/website.md).
