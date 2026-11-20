# Local CLI and SDK developer playtest

Date: 2026-10-27. Product source revision: `4d8a2e73d4930ddbc064433808748758341ca2db`.
Environment: Windows x64, Chrome `156.0.8078.47`, compiled local CLI reporting
`0.2.0-preview.1`, locally packaged SDK `0.2.0-dx.1`.
This is an independent developer-workflow audit, not a replay of the conformance suite.

The audit uses locally produced SDK payloads and an isolated author cache. Packaging
and serving that unpublished SDK is test-harness setup, not a requirement for
ordinary users of published releases. Generated games, raw logs and screenshots
are retained under `build/dx-playtest/`; this report uses portable paths.

All six requested workflows were exercised successfully. No blocking runtime or
game-authoring failure remained. The main confirmed DX surprise is whole-build
replacement when changing target or packing; details and tradeoffs are below.

| Requested workflow | Outcome | Evidence under `build/dx-playtest/` |
| --- | --- | --- |
| Create a game | Passed; three-file scaffold, installed-SDK offline selection, custom game checks/builds | `logs/`, `sdk-requests.json` |
| Iterate on the game | Passed; changed speed observed at 150 units/second and TOML button label updated | `dev-report.json` |
| Start the dev server | Passed; real browser play, automatic reload, compile-error recovery, active export survives packing | `dev-report.json`, `dev-pack-report.json` |
| Package a cartridge | Passed; original PNG independently opened and played in the stock local picker | `custom-report.json`, `packed-file-player.png` |
| Use the native player | Passed; interactive three-target win and separate deterministic collection/reset replay | `native-win.png`, `native-report.json` |
| Create a custom runtime player | Passed; independently authored UI, nested URLs, public controls/events/lifecycle only | `custom-site/nested/custom/`, `custom-report.json`, `custom-player-win.png` |

## Initial documentation observations

- The getting-started guide explains the three-file project and one-shot versus
  watching commands clearly. It still calls the player button **Start game**;
  the new production player calls it **Play**. This should be updated when the
  new player preview is published.
- Public runtime and production-player guides are separate and make the execution
  versus UI boundary clear. The runtime example demonstrates named input sources,
  but a complete keyboard/pointer adapter and a minimal runnable custom-host
  directory would reduce the amount a new developer has to assemble.

## Evidence and findings

### Local distribution setup

The audit produced and assembled unpublished SDK `0.2.0-dx.1` with the existing
`build:sdk-components` and `assemble:sdk-release` mise tasks. The candidate and
release live under `build/sdk-components/0.2.0-dx.1/windows-x64/` and
`build/dx-playtest/release/`. A small local HTTP fixture serves its metadata and
component archives. This setup is intentionally separate from the game-author
workflow. CLI invocations run with an empty PATH, an isolated author cache and
`BYTORIO_SDK_RELEASE_ROOT` pointing to the fixture.

Harness reproduction, from the checkout root:

```sh
node build/dx-playtest/local-sdk-server.mjs
# In another terminal, the wrapper invokes the compiled local byt binary:
node build/dx-playtest/cli.mjs new star-collector --sdk 0.2.0-dx.1
node build/dx-playtest/cli.mjs new offline-starter --offline
node build/dx-playtest/cli.mjs check star-collector
node build/dx-playtest/cli.mjs build star-collector
```

The corresponding developer commands are `byt new star-collector --sdk
0.2.0-dx.1`, followed by `byt check` and `byt build` inside that game. The local
SDK override and author cache must be configured when bypassing the audit wrapper.

### Creation, checking and building: passed

- Creation produced exactly `bytorio.toml`, `bytorio.lock.toml`, and
  `src/main.luau`. The lock pins the exact local SDK and metadata checksum.
- A second project with `new offline-starter --offline` selected that installed
  SDK without a version argument.
- The author wrote **Star Collector**, a small game with movement, three targets,
  score, sound cues and action-button restart. Its project is retained at
  `build/dx-playtest/workspace/star-collector/`.
- Both `check` and `build` succeeded from the isolated cwd with no compiler or
  JavaScript runtime on the CLI child's PATH. Components downloaded lazily:
  core/analyzer/checker/executor during checking, then web player during building.
- Player configuration in the existing TOML file enabled visible D-pad controls
  and an action button labeled Reset. No new authored project files were needed.

Evidence: `build/dx-playtest/logs/`, `sdk-requests.json`, and
`stock-game-collected.png` under the same audit directory. The screenshot shows
the actual custom game after collecting a target; the runtime reported score 1
and two played sound cues (initialization plus collection).

### Edit/play loop and recovery: passed

`byt dev star-collector --no-open` opened a working production player through the
CLI's own server. The audit collected a target using the keyboard, changed
movement speed from 90 to 150 units/second, and observed an automatic reload and
measured movement at 150 units/second. Changing the TOML action label from Reset
to Restart also rebuilt and reloaded the page.

A deliberate invalid Luau edit printed diagnostics and left the prior valid
export playable at the same URL. Fixing the source and changing the background
color produced another automatic reload and a working game. Evidence:
`build/dx-playtest/dev-report.json`, `dev-stdout.log`, `dev-stderr.log`, and
`stock-game-after-iteration.png`.

### Packaging and native player: passed

```sh
byt pack star-collector --output star-collector/dist/star-collector.png
byt build star-collector --offline
byt build star-collector --target native
byt run star-collector --target native --offline
```

These commands were invoked from the audit workspace, so the output path is
relative to that directory. The PNG is retained at
`build/dx-playtest/workspace/star-collector/dist/star-collector.png`.

The actual SDL native window opened and rendered the authored game. Using native
pointer input, the audit collected all three targets and observed score 3/3 and
the win message, then closed the window. This was interactive execution, not an
SDL dummy-driver smoke test. Evidence: `build/dx-playtest/native-win.png`.
The FPS/memory counters remain visible in the native window title; a production
title option could be a future polish improvement, separate from the new web shell.

A separate 51-update replay through `byt run --target native --offline --
--replay ../../replay-inputs.txt` confirmed collection and reset transitions: sound
counts 1 → 2 → 3 and a changed framebuffer hash. Evidence:
`build/dx-playtest/native-report.json`. Replay arguments are relative to the
native export cwd, a detail not currently explained in the author guide.

### Runtime-only custom player and independent PNG: passed

The retained custom site has this layout:

```text
custom-site/
  nested/
    custom/
      index.html
      player.js
      cartridge.png
    sdk/
      runtime.js
      session.js
      worker.js
      ...complete copied web export and supporting assets...
```

`player.js` imports only `../sdk/runtime.js`; it never imports the stock player,
bootstrap, debug host, or private Worker protocol. The site supplies its own
styling, canvas, keyboard/pointer adapters and Play/Pause/Reset/Mute/Restart UI.
The audit played the game to score 3/3, received public frame events, paused,
muted, restarted, deliberately loaded malformed PNG bytes, recovered by loading
the original cartridge, and disposed the runtime. The module assets and game
URL were in different directories under a nested URL prefix, verifying the
document-relative cartridge versus module-relative support-file distinction.

The same PNG was then selected through the stock `player.html?local` file picker
and played independently of the source project. Browser request evidence confirms
that the custom host did not import `web-player.js`, `bootstrap.js` or
`debug-player.js`. Evidence: `custom-report.json` and `custom-player-win.png`.

To review the site, serve `build/dx-playtest/custom-site/` with any static HTTP
server and visit `/nested/custom/index.html`. It requires no npm install or
Bytorio source files in the deployed app. The audit harness uses the repository's
small static server only as test infrastructure.

### Confirmed DX issue: target/pack commands replace existing exports

Priority: **P2 documentation/behavior mismatch**, not data loss of authored source.
The CLI publishes a complete owned build snapshot rather than preserving other
targets from an earlier command. Reproduction from inside the game:

```sh
byt build --target all
# build contains: generated/, native/, web/, .bytorio-output.json, game.png
byt pack --output dist/star-collector.png
# build now contains only: generated/, .bytorio-output.json, game.png
```

Likewise, `byt build --target native` after a web build leaves `native/` and removes
`web/`. Starting `byt dev` also publishes a web build, replacing the native target.
This first surfaced as a failed copy of `build/web/` while preparing the custom
site after using the native player.

The getting-started guide presents `check`, `build` and `pack` together, then
describes sharing `build/web/`. A developer who runs that sequence no longer has
the web folder to share. The output messages mention only the newly built target
or packed PNG and do not warn that another export disappeared.

The active dev session is safe: after packing removed the canonical web folder,
the previously served dev game continued advancing and a full page reload still
worked from the CLI's separate served snapshot. Evidence:
`dev-pack-report.json`, which records the exact before/after directory listings.

Suggested improvement: first document whole-build replacement and recommend
`build --target all` or copying finished exports outside `build/` before switching
targets. Consider whether `pack` can emit its PNG without removing existing
players. Preserving targets automatically has stale-output/provenance tradeoffs;
this audit does not assume that keeping every old export is always correct.
Both final reviewable exports have been restored with `build --target all`.

### Synthetic sub-frame action taps: confirmed limitation, not a realistic-tap bug

The initial browser pass collected a target successfully, then an immediate
synthetic `keyboard.press("Space")` did not reset the game. It remained playable
until the verifier's 30-second wait expired. That does not establish a realistic
human-input defect. Measured events were focused and the keydown was handled,
but the gap between keydown/up was only **0.5 ms**. A held Space press reset
immediately. The first attempt is retained as
`build/dx-playtest/dev-report-first-attempt.json`; event timing is in
`dev-report.json`. An additional comparison produced these results:

| Requested key hold | Measured holds | Successful resets |
| --- | --- | --- |
| Immediate synthetic press/release | 0.4–1.2 ms | 0/6 |
| 30 ms | 31–46 ms | 6/6 |
| 60 ms | 65–74 ms | 6/6 |

All samples were focused. The game samples held state on simulation updates, so
sub-frame down/up pairs can disappear between updates. This matters for browser
automation and could motivate an input-edge queue or a documented minimum test
hold. It does **not** demonstrate failure of realistic short taps in this audit.
The custom host's documented `pulseInput()` reset button also worked. A Computer
Use Space tap was also not observed by native gameplay, but its timing is unknown;
the native deterministic replay did validate the action binding and reset logic.

### Additional improvements and documentation gaps

- **P3, release documentation:** update Start game to Play when the production
  player is published. The current release-versus-next-preview wording is valid;
  do not imply that the local-only player is already on GitHub.
- **P3, native discoverability:** CLI `--help` does not show the `--` argument
  forwarding escape hatch. The frame-pacing guide demonstrates it, but an explicit
  usage line and a native-player option reference would avoid source inspection
  for replay/capture diagnostics. Explain that player-relative paths resolve from
  the native export directory.
- **P3, custom-host onboarding:** include a complete downloadable minimal site
  with its exact file tree, module import, HTTP launch command, input adapters and
  error/disposal handling. The separate runtime and stock-player guides explain
  the architecture well, but the runtime snippet alone is not an end-to-end host.
- **P3, dev feedback:** failed builds correctly preserve the last good game and
  print terminal diagnostics. A development-only browser status/error indicator
  could make it clearer that the visible game is stale after a compile error.
  This should remain separate from the production player's normal UI.

## Review commands and retained artifacts

The generated game is `build/dx-playtest/workspace/star-collector/`. With the
local SDK fixture running, these root-relative audit commands use the compiled
CLI with the isolated cache and empty child PATH:

```sh
node build/dx-playtest/local-sdk-server.mjs
# In a second terminal:
node build/dx-playtest/cli.mjs dev star-collector --no-open --offline
node build/dx-playtest/cli.mjs run star-collector --target native --offline
node build/dx-playtest/cli.mjs build star-collector --target all --offline
```

To review the independent custom site using the existing contributor server:

```sh
node tools/serve.mjs build/dx-playtest/custom-site
# Open http://127.0.0.1:8080/nested/custom/index.html
```

`build/dx-playtest/provenance.json` records artifact SHA-256 values, browser
version and the local artifact identity. There were seven local SDK HTTP requests:
one metadata request and six lazy component downloads. No published SDK assets
were used. The full export and native player were retained, along with the
original packaged PNG and independently authored custom site.

All audit-owned dev/static/SDK servers, browser processes and the interactive
native window were closed. No product source was modified to make scenarios pass.
After stopping the SDK fixture, `check --offline` and `build --target all
--offline` still succeeded, leaving both final player exports available for review.

## Follow-up resolutions

The subsequent CLI fix preserves unselected web/native exports and prints their
update commands. `pack` keeps both exports. Each retained target keeps its own
cartridge and matching SDK files; the audit's whole-build replacement observation
above describes the earlier implementation. The compiled SDK consumer check now
exercises target switching and packaging retention.

The [getting-started guide](../getting-started.md) explains stale retained exports
and failed-development-build feedback. [Native player guidance](../native-player.md)
and CLI help explain argument forwarding and path resolution. The
[runtime guide](../../sdk/web-runtime.md) documents input sampling and the complete
runtime-only custom host now included in web exports. Play/Start game wording
distinguishes the upcoming player from older SDK pins. Browser error overlays
and native window-title polish remain suggestions, not changes in this follow-up.

## Audit limits

This audit ran the Luau path on Windows x64 and desktop Chrome. It did not test
Odin authoring, macOS, Safari, physical phones/tablets, touch hardware, gamepads,
screen readers, deployment CSP variations or browser audio audibility. On-screen
controls were configured and rendered; the primary gameplay interactions were
keyboard and pointer input. Native playback was visibly interactive, while its
separate replay was deterministic and non-interactive. These outcomes complement,
rather than replace, the project's platform and conformance suites.
