# Getting started with Bytorio

Create games in Luau or Odin, play them in a browser or native player, and share
them as PNG cartridges. Install `byt`; it downloads the matching SDK, language
tools and players when needed. No Bytorio checkout, Node, Bun, Odin, Emscripten,
Xcode or Visual Studio installation is needed to make and run a game.

You can also [play the browser demos](https://bytor.io/showcase/) immediately.

## Installation status

Choose a **Bytorio CLI** release with standalone authoring support from the
[releases page](https://github.com/ctxshift/bytorio/releases), including previews.
Earlier scaffolding-only releases cannot build or play games.

| Host | Luau and browser | Odin and native player |
| --- | --- | --- |
| Windows x64 | Supported | Supported |
| macOS Apple Silicon | Supported | Supported |
| macOS Intel | Supported | Unavailable with the pinned Odin toolchain |

Linux authoring packages are not available yet. Current SDK previews include an
embeddable browser runtime, production player and configurable touch controls.
Older SDK pins keep their previous player until explicitly upgraded.

## Download the CLI

Open the [releases page](https://github.com/ctxshift/bytorio/releases) and choose
the newest **Bytorio CLI** release (`byt-v...`). SDK releases (`sdk-v...`) are
dependencies managed by `byt`. Source-code archives are not the CLI.

### macOS (Apple Silicon or Intel)

In **Apple menu > About This Mac**, an M-series **Chip** means Apple Silicon;
an Intel **Processor** means Intel. See [Apple's chip identification guide](https://support.apple.com/en-us/116943).

| Mac | Executable | SHA-256 manifest |
| --- | --- | --- |
| Apple Silicon | `byt-macos-arm64` | `release-macos-arm64.json` |
| Intel | `byt-macos-x64` | `release-macos-x64.json` |

Download both files into **Downloads**. These commands use Apple Silicon; on
Intel, substitute `byt-macos-x64`:

```sh
cd "$HOME/Downloads"
shasum -a 256 byt-macos-arm64
```

Compare the hash with `sha256` in the JSON manifest, then:

```sh
mv byt-macos-arm64 byt
chmod +x byt
./byt --version
./byt --help
```

Mac binaries are ad hoc signed and not notarized. If macOS blocks the first
launch, follow [Apple's instructions for a trusted download](https://support.apple.com/en-us/102445):
after attempting to launch it, use **System Settings > Privacy & Security >
Open Anyway**, then try again.

To use `byt` from any folder:

```sh
mkdir -p "$HOME/.local/bin"
install -m 755 ./byt "$HOME/.local/bin/byt"
export PATH="$HOME/.local/bin:$PATH"
byt --version
```

For the default zsh shell, add that `export` line once to `~/.zshrc` and open a
new Terminal window. No administrator access is needed.

### Windows x64

Download `byt.exe` and `release.json` into a folder you keep. In PowerShell,
compare `Get-FileHash .\byt.exe -Algorithm SHA256` with the manifest's `sha256`,
then run:

```text
.\byt.exe --version
.\byt.exe --help
```

The Windows executable is unsigned. Add its folder to your user PATH and reopen
the terminal to use `byt` anywhere. Without a PATH entry, use the executable's
full path, `.\byt.exe` from its folder on Windows, or `./byt` on Mac.

## Install with mise

If you use [mise](https://mise.jdx.dev/getting-started), choose a CLI release from
the [releases page](https://github.com/ctxshift/bytorio/releases) and replace
`<version>` below, keeping its full `byt-v` tag prefix:

```toml
[tools]
"github:ctxshift/bytorio" = "byt-v<version>"
```

```sh
mise trust
mise install github:ctxshift/bytorio
mise exec -- byt --version
```

Alternatively, run `mise use github:ctxshift/bytorio@byt-v<version>`. Add
`--global` for a personal default. Use `byt` with mise shell activation, or
prefix commands with `mise exec --`.

Mise selects `byt-windows-x86_64.tar.gz`, `byt-macos-aarch64.tar.gz` or
`byt-macos-x86_64.tar.gz`, containing `byt.exe` or `byt` at its root. These names
also support older mise versions. No extra asset options or minimum mise version
are required. Run consumer commands outside the Bytorio checkout, whose tool
configuration is for contributors. See [advanced mise installation](mise-installation.md)
for automatic updates, checksum locks and an optional SDK metadata task.

## Create and run a game

From a folder where you keep projects:

```sh
byt new my-game
cd my-game
byt run
```

`new` defaults to Luau and creates just three files:

```text
my-game/
  bytorio.toml
  bytorio.lock.toml
  src/main.luau
```

`bytorio.toml` contains your settings. `bytorio.lock.toml` pins the exact SDK
release and metadata checksum. Commit both with the source. Creation prefers the
newest compatible installed SDK; if none is installed, it discovers the newest
compatible release, including previews. Only metadata downloads at this stage.

`run` checks and builds the game, downloads required SDK components on first
use, serves it locally and opens a browser tab. Choose **Play** (**Start game**
in older SDK players) to enable sound. Use arrow keys to move and Space for a
sound. Ctrl+C stops the server.
`run` builds once. For Odin on Windows or Apple Silicon:

```sh
byt new my-odin-game --language odin
byt run my-odin-game
```

## Make your first change

Inside the game directory:

```sh
byt dev
```

Open `src/main.luau`. The starter returns `init`, `update(dt)` and `draw`
callbacks. Change the background color in `draw` or movement speed in `update`,
then save. `dev` rebuilds and reloads the browser. Failed builds print diagnostics
and preserve the last working game; fix the source and save again to recover.
Choose **Play** again after reloading if audio needs a user gesture. Older SDK
players label this **Start game**. Watch the terminal while iterating: if a build
fails, the browser still shows the last successful version, not the failed edit.

The first check/build generates ignored SDK editor files and build output.
They are not extra authored project requirements. See [graphics](../sdk/graphics.md),
[audio](../sdk/audio.md) and [the API reference](../sdk/api.md).

## Check, build and share

Inside the game directory, or with its path after the command:

```sh
byt check
byt build
byt pack
```

`build` exports a complete browser player under `build/web/`. Host the whole
folder using static HTTP hosting, serving `.wasm` as `application/wasm`. Opening
the HTML as a `file:` URL does not work. Exports play without the SDK cache or a
Bytorio server.

`pack` writes `build/game.png`. Share the original file with a compatible player;
resizing or re-saving it can remove game data. Use `--output dist/my-game.png`
or `--cover art/cover.png` for packaging options. See [PNG cartridges](png-cartridges.md).

On Windows or Apple Silicon:

```sh
byt run --target native
byt build --target native
byt build --target all
```

Share the entire `build/native/` folder for a standalone native game. Native
exports target the authoring host. Plain `build` remains web only.

Each command replaces only the target it builds. A web-only build keeps an
existing native export unchanged and prints how to update it:

```text
Kept native export unchanged; run byt build --target native to update it.
```

That retained export still contains its previous game and matching player;
it may be older than your latest edits. Use `byt build --target all` to refresh
both. `pack` updates the root cartridge and keeps both existing player exports.
`run` and `dev` follow the same target rules. Author files outside `build/`:
it is generated output, and rebuilding a selected target replaces that entire
target directory. `--output` paths are relative to your terminal's working
directory; use a path such as `dist/my-game.png`, outside `build/web/` and
`build/native/`.

To pass native player options, put them after `--`:

```sh
byt run --target native -- --fps native
```

See [native player options and path rules](native-player.md).

## Embed and customize the web player

Current CLI/SDK previews include an embeddable production player and a separate
runtime module. Existing SDK pins keep their previous player until explicitly
upgraded with `byt sdk upgrade` inside the game directory.
The player frames the game with Play/Pause, Mute and Fullscreen; Restart and Open
cartridge are in its menu. Development diagnostics are off by default.

Optional settings live in your existing `bytorio.toml`:

```toml
[player]
instructions = "Arrows / WASD move. Space jumps."

[player.controls]
preset = "dpad"
visibility = "auto"

[player.controls.overrides.action]
label = "Jump"
bindings = ["action"]
```

`auto` shows controls on touch devices. Choose tap/drag with `preset = "pointer"`,
override preset bindings and layout, or define an explicit layout. Build-time
validation reports unsupported controls before export.

Import `web-player.js` to mount the stock player in your own page, or import
`runtime.js` to build your own player. Neither requires the Bytorio source,
a framework or an npm install. Keep the complete exported web directory together.
See [embedding and touch controls](../sdk/web-player.md) and the
[runtime API](../sdk/web-runtime.md). Contributors can open `debug.html` for the
separate diagnostic host.

## SDK versions and offline use

The pinned SDK selects matching libraries, tools, check workers and players.
A newer CLI does not change an existing game's SDK. To select one explicitly:

```sh
byt new pinned-game --sdk <sdk-version>
byt sdk upgrade
byt sdk upgrade --sdk <sdk-version>
```

Run `upgrade` inside an existing game. Online it discovers the newest compatible
release; an exact version selects that release. It changes only the generated
lock file. Review and commit the changed pin. SDK distribution versions and
cartridge API/profile versions are separate. Set `profile` in `bytorio.toml`
to opt into an experimental API supported by the pinned SDK.

Downloads are shared across games in `%LOCALAPPDATA%/Bytorio/Cache` on Windows
or `~/Library/Caches/Bytorio` on Mac, with digests checked before use.
`BYTORIO_CACHE_DIR` selects another cache. After an online build:

```sh
byt build --offline
byt run --offline
byt new another-game --offline
```

An uncached target or tool needs an online download first. `byt sdk install
<sdk-version>` caches verified metadata; components remain lazy. `byt sdk upgrade
--offline` selects a compatible cached release. SDKs need no separate mise entry.

## If something goes wrong

| Symptom | What to check |
| --- | --- |
| `byt` is not recognized | Add its folder to PATH, use its full path, or use `mise exec -- byt`. |
| Mac reports `permission denied` | Run `chmod +x byt`. |
| Mac reports `bad CPU type` | Download the binary matching your Mac's chip. |
| macOS blocks the developer | Follow the first-launch instructions above. |
| Offline component is missing | Run the same command online once, then retry offline. |
| Existing `build` directory is not owned by byt | Move authored files out; byt refuses to overwrite them. |
| Missing SDK lock file | Run `byt sdk upgrade` inside the game. |
| Browser audio is silent | Choose **Play** (**Start game** in older SDK players) and check audio permissions. |
| Browser still shows the old game after an edit | Check the `byt dev` terminal for a failed build; fix the error and save again. |
| Another command is publishing | Wait for it to finish. After an interrupted command, only if no `byt` commands are running, remove `.bytorio/staging/publish.lock` inside the project and retry. |

## Work on Bytorio itself

The source toolchain is for contributing to the console or rebuilding runtime,
players and SDK releases. See [development](development.md). Existing
`console.json` games continue to use that contributor adapter; their SDK/API
numbers are not silently reinterpreted as distribution pins. Ordinary new games
use the standalone workflow above.
