# Getting started with Bytorio

Bytorio lets you make a small game in Luau or Odin and share it as a PNG
cartridge. Start with Luau if you are new to programming. Both languages use
the same console capabilities.

You can [play the browser demos](https://bytor.io/showcase/) without installing
development tools. Choose **Load game**, then **Start game** to enable sound.

## Installation status

The **Windows x64 CLI preview** is available as a single download. It creates
Luau and Odin projects and downloads versioned SDK bundles without Node, Bun,
mise or a source checkout. **It cannot build, check, run or pack games yet.**
For a playable game, continue with the source setup below, which currently
requires Windows x64 or macOS arm64, for native players and browser exports alike. Linux authoring
packages and an automatic installer are not available yet.

## Download the CLI preview

1. Open the [CLI preview release](https://github.com/ctxshift/bytorio/releases/tag/byt-v0.1.0-preview.1).
2. Under **Assets**, download `byt.exe` and `release.json` into a folder you keep,
   such as a `bytorio-tools` folder. The source-code archives are not the CLI.
3. Open PowerShell in that folder. Optionally verify the download by running
   `Get-FileHash .\byt.exe -Algorithm SHA256` and comparing it with `sha256` in
   `release.json`.
4. Run:

```text
.\byt.exe --version
.\byt.exe sdk install 0.1.0-preview.1
.\byt.exe new preview-game --sdk 0.1.0-preview.1 --offline
```

The version should be `0.1.0-preview.1`. The last command creates a Luau project
and `byt.lock.json`, which pins the downloaded SDK bundle. Add `--language odin`
to create an Odin project instead. Keep the lockfile with the game source.
The SDK download needs internet once; subsequent use of that version works
offline. The preview executable is currently unsigned.

PowerShell uses `.\byt.exe` to run a program in the current folder. You can
optionally add the folder containing the executable to your user PATH, reopen
the terminal, and use `byt` from any folder. A mise installation route will be
documented after it has been verified; mise is not required for this preview.

Trying `check`, `build`, `run`, `watch`, `pack` or `import` in this preview gives
an explicit unsupported-command message. These commands require the source CLI
below. To use the project you just created, run `mise run byt -- check <project>`
and `mise run byt -- run <project> --web` from that checkout, replacing `<project>`
with its path. Do not run `new` over an existing project. The source CLI does not
yet enforce the preview's SDK bundle lock; use the source revision identified
in the release notes when trying this fallback.

## Install the development tools

Install [Git](https://git-scm.com/downloads),
[mise](https://mise.jdx.dev/getting-started), and the Windows linker prerequisites
in [Odin's installation guide](https://odin-lang.org/docs/install/).
The tested native setup uses Visual Studio's **Desktop development with C++**
workload. These are development requirements; people playing exported games do
not need them.

Open a terminal in a folder where you keep projects, then run:

```text
git clone https://github.com/ctxshift/bytorio.git
cd bytorio
mise trust
mise install
mise exec -- npm ci
mise run byt -- --help
```

`mise trust` allows this checkout's tool configuration to run. Review the source
before trusting it. Mise installs the pinned compilers and build tools; npm
installs the JavaScript dependencies. The first setup needs an internet
connection and may take a while. The final command should print `Usage: byt`.

## Create and run a game

Stay in the Bytorio source folder and run:

```text
mise run byt -- new ../my-game
mise run byt -- check ../my-game
mise run byt -- run ../my-game --web
```

This creates a separate `my-game` folder beside the checkout. The first check
also builds the player components; subsequent commands reuse build artifacts.
Open the player URL printed by the last command, then choose **Start game**.
Use the arrow keys to move the sprite and Space to play a sound.
Press Ctrl+C in the terminal to stop the local server.

The rest of the guides use `byt` as shorthand for the full authoring CLI. The
downloadable preview supports only the commands listed above. For this
source setup, replace `byt` with `mise run byt --` and run it from the
Bytorio checkout. Project paths remain relative to your terminal's folder.
For example, `byt pack ../my-game` becomes `mise run byt -- pack ../my-game`.

For Odin, add `--language odin` to `new`; use a different, nonexistent project
folder. To run a native export, use `--native` instead of `--web`.

## Make your first change

Open `my-game/src/main.luau` in a code editor. The starter has three callbacks:

- `init` sets up the game when it starts.
- `update(dt)` changes game state, reads controls and triggers sounds.
- `draw` draws the current state without advancing the game.

Find `byt.clear(byt.rgb(23, 32, 46))` in `draw` and change the three color
values. Save the file, stop the server and run the web command again. The
background should change. Then try changing the movement speed, `90`, in
`update`; keep the multiplication by `dt` so the speed stays tied to game time.

Use [the API reference](../sdk/api.md) to look up drawing and input operations.
The [glossary](../GLOSSARY.md) explains terms such as cartridge, tick and resource.

## Share your game

From the source checkout:

```text
mise run byt -- pack ../my-game
```

The cartridge is `my-game/build/game.png`. Send the original file to someone
with a compatible player. Resizing or re-saving the image can remove the game.
See [PNG cartridges](png-cartridges.md) for cover art and player exports.

## If something goes wrong

| Symptom | What to check |
| --- | --- |
| `mise` is not recognized | Finish the mise installation and open a new terminal. |
| `byt` is not recognized | Use `.\byt.exe` from the download folder, or add that folder to your user PATH and reopen the terminal. |
| Preview says a command is unsupported | Use the source CLI below for build/check/run/pack/import/watch. |
| No mise task named `byt` | Run the command from the Bytorio checkout, not from `my-game`. |
| Missing compiler or linker | Complete `mise install` and the Windows linker prerequisites above. |
| Project folder already exists | `new` creates a fresh project; choose another folder or run the existing project. |
| Server port is already in use | Stop the previous server, or add `--port 8081`. |
| No sound | Choose **Start game** and interact with the player; browsers require a gesture to enable audio. |

For console builds, tests and runtime internals, see
[Contributor documentation](contributing.md).
