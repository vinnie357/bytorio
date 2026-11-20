# Standalone CLI distribution plan

Status: the original scaffolding preview is superseded by the published
standalone authoring release described in the [current plan](standalone-authoring-plan.md).
The built-in mise GitHub backend installs the CLI through the [consumer recipe](../../install/mise.toml).
The [standalone authoring specification](standalone-authoring-spec.md) records
the agreed DX requirements, SDK-owned players and public browser runtime model;
the [implementation plan](standalone-authoring-plan.md) sequences that work.
Those documents govern full-authoring behavior. Details below retain the
original protocol-1 scaffolding design for compatibility; current projects use
TOML pins, component SDK releases and SDK-owned authoring and players.
The [standalone CLI decision](../adr/0017-distribute-a-standalone-authoring-cli.md)
sets the user experience. This document describes the recommended implementation
and the checks needed before publishing installation instructions.

## Implemented foundation

`mise run build:cli` compiles the host's scaffolding preview to
`build/cli/byt.exe` on Windows or `build/cli/byt` on macOS, with its platform,
version, file size and SHA-256 in `release.json`.
It uses pinned Bun and a type-checked TypeScript entry point. SDK templates,
the contract and Luau editor modules are embedded; no source checkout or separate
JavaScript runtime is needed to run `byt new`.

The preview supports `new`, `sdk install`, `--help` and `--version`. It explicitly rejects
check/build/run/watch/pack/import: toolchain caching, project locks and prebuilt
player resolution are not implemented yet. Continue using the source CLI for
those operations. The preview is distributed as `byt.exe`, `byt-macos-arm64` and
`byt-macos-x64` in the
[CLI releases](https://github.com/ctxshift/bytorio/releases).

`mise run validate test:cli test:sdk` checks compiled/source scaffold parity for
both languages, existing-directory protection, invalid arguments and operation
without tools on PATH. The compiled binary is copied into a temporary directory
outside the checkout for verification. This isolates working-directory and PATH
dependencies; it does not substitute for release testing on a clean machine.
The full validation suite includes `test:cli`.

Versioned SDK bundles now support release-based scaffolding and an SDK-only lock.
The next slice should add prebuilt player bundles and verified toolchain cache
entries, extending project locks before enabling build commands in the binary.
Retain the source-build provider for contributors.

## Distribution shape

Use TypeScript and Bun for the authoring CLI, compiling a separate standalone
`byt` executable for each supported operating system and architecture. Users
install the executable without separately installing Bun, Node.js or mise.
The existing JavaScript CLI remains the source-checkout implementation until
the compiled replacement passes parity checks.

[Bun's executable support](https://bun.sh/docs/bundler/executables) covers
TypeScript/JavaScript, embedded files and explicitly included worker entry points.
That makes it a suitable packaging route, not proof that the current CLI can be
compiled unchanged. Preserve the CLI's timeout/isolation behavior when adapting
its worker-based cartridge checks. Keep repository build orchestration in mise;
this work does not require migrating every repository script to Bun.

Keep an embedded starter for offline scaffolding and allow explicit SDK bundle
selection independently of the CLI version. Obtain compiler and prebuilt player
packages from a versioned release manifest in the later build integration.
Native executables and libraries must be installed into real cache directories
before execution or export; bundling the CLI does not eliminate those files.

## Project versions and dependency ownership

Recommend a project lockfile recording the exact SDK bundle, toolchain and
artifact checksums resolved for the project's declared SDK/profile. The lockfile
format and filename need definition during implementation. Do not silently
re-resolve an existing project against newer compiler releases.

Store dependency versions side by side in a user-level Bytorio cache. Projects
using the same version share downloads, while projects on different releases
retain compatible tools. Invoke cached tools by absolute resolved paths; do not
replace global Odin or Luau commands or depend on whichever version is on PATH.

| Component | Game-author distribution | Console-contributor setup today |
| --- | --- | --- |
| CLI JavaScript runtime | Included in the compiled Bun executable | Pinned Node.js |
| SDK interfaces, templates and schemas | Versioned SDK bundle | Source checkout |
| Luau analyzer | Verified prebuilt tool for Luau projects | Mise-managed analyzer |
| Luau executor/compiler bridge | Prebuilt compatible Wasm artifact | CMake/Emscripten build |
| Odin compiler | Pinned tool for Odin projects | Mise-managed compiler |
| Odin formatter used for generated source | Include a pinned formatter or remove this authoring dependency deliberately | OLS/odinfmt |
| Browser player, audio and decoder modules | Prebuilt release bundle | Odin/Emscripten builds |
| Native player and libraries | Prebuilt host-specific bundle with notices | Odin, linker, SDL and Wasmtime dependencies |
| CMake, Ninja, Emscripten, Python, native runtime linker tools | Not required merely to author a game | Required for relevant runtime source builds |

Check whether each target's Odin cartridge compiler needs additional linker
assets; package those with its toolchain instead of assuming the compiler alone
is sufficient. Luau-only authoring must not install Odin merely to rebuild a player.

Mise should install and pin the `byt` release, not independently choose Odin and
Luau versions for that project. Optional generated mise configuration can select
`byt`; the project lockfile remains the authority for its SDK toolchain.
The [mise GitHub backend](https://mise.jdx.dev/dev-tools/backends/github.html)
can install release assets. Publish the exact installation command only after
the release repository, asset names and supported platforms are established.

## Downloads, updates and recovery

- Release metadata identifies platform, version, download size, checksums and
  required licenses. Verify against trusted release metadata before extraction.
- Show required downloads before fetching them. Install into a staging directory
  and publish a complete cache entry only after verification; interrupted
  downloads must not replace a working toolchain.
- Reuse verified cache entries and support offline builds once the required
  bundles are installed. Missing offline dependencies should name what is needed.
- Make toolchain updates explicit. Updating the CLI must not silently migrate
  game sources, profiles, lockfiles or existing project dependencies.
- Provide diagnostics for selected tools, cache locations and missing components.
  Command names for diagnostics, updates and cache cleanup are not implemented yet.
- Keep the game project and cached toolchains after CLI uninstall unless the user
  explicitly requests their removal. Preserve attribution in exported players.

## Work required in the current implementation

The [standalone authoring plan](standalone-authoring-plan.md) supersedes the
initial scaffolding rollout sequence. It covers selected-SDK authoring without
checkout paths, prebuilt player/tool components, a public browser runtime,
the production default player, project migration and clean consumer qualification.
Keep the contributor source-build provider explicit. CLI scaffolding availability
on a platform does not establish full SDK authoring support there.

## Release acceptance

On a clean machine without Node, Bun, mise or a console checkout, create, check,
run and pack both Luau and Odin starter games. Verify imported models, embedded
templates, worker failure recovery, native/browser exports and license contents.
Test project paths with spaces, concurrent dependency requests, interrupted and
corrupt downloads, unsupported platforms, offline reuse and two projects pinned
to different toolchains. Compile each target separately and test it on that target;
cross-compilation alone does not establish platform support.

## Versioned SDK release bundles

The standalone preview supports `byt sdk install <version>` and
`byt new my-game --sdk <version> [--language odin|luau]`. Add `--offline` to
require a cached SDK. Without `--sdk`, project creation uses the embedded starter.
The first SDK bundle is available in the
[`sdk-v0.1.0-preview.1` release](https://github.com/ctxshift/bytorio/releases/tag/sdk-v0.1.0-preview.1).

SDK bundle release versions are independent of the cartridge SDK/profile values
in `console.json`. A single bundle contains the supported profiles and both
language libraries. Downloaded projects record the bundle version and SHA-256 in
`byt.lock.json`; commit this file with the game. This initial lock schema pins
only the SDK bundle. Compiler/player locks and enforcement during builds remain
unimplemented, as do standalone build commands.

Run `mise run build:sdk-release -- 0.1.0-preview.1` to produce
`build/sdk-release/0.1.0-preview.1/sdk-release.json` and its compressed SDK asset.
The bundle contains SDK source, templates, schemas, documentation and available
root license files. It contains no executable hooks, compilers or players.
The CLI reads assets from a compressed JSON map rather than extracting arbitrary
archive paths. Manifest protocol 1 defines the CLI/bundle compatibility boundary;
unsupported protocols fail with an upgrade message.

Push a reviewed `byt-v<version>` or `sdk-v<version>` tag to run
`.github/workflows/release.yml`. Tagging is the publication action: after the full
validation gates pass, the workflow uploads and publishes the actual release
assets. Versions containing a prerelease suffix are marked as prereleases.

For CLI tags, `BYTORIO_RELEASE_TAG` sets the compiled version. The workflow
publishes the exact executable exercised by `test:cli` on each architecture.
Windows retains `byt.exe` and `release.json`; macOS uses `byt-macos-arm64` and
`byt-macos-x64`, with `release-macos-arm64.json` and `release-macos-x64.json`.
CLI releases also publish `byt-windows-x86_64.tar.gz`,
`byt-macos-aarch64.tar.gz` and `byt-macos-x86_64.tar.gz`. Each contains only the
tested executable, named `byt.exe` or `byt`, with neutral archive ownership.
Mise prefers these platform-named archives, including historical versions that
cannot detect the generic Windows executable or normalize raw binary names.
Each existing platform manifest keeps its raw binary fields and adds an
`archive` object with asset name, byte count and SHA-256. Publication verifies
both forms, including archive membership and the extracted executable hash.
Mac binaries are ad hoc signed before verification and hashing; distribution
signing and notarization remain future work. Windows and Apple Silicon jobs run
the complete validation suite, including native and browser conformance and
Mac loader/signature checks. Intel Mac jobs install only the CLI's build tools
and run `test:cli`; the pinned Odin release has no Intel compiler asset.
Publishing requires every platform's binary and
verifies all three manifests after artifact download.
SDK tags package the bundle and `sdk-release.json`; CLI and SDK tags are
independent. Publish a required SDK version before directing users to install it.
The publish job verifies each asset's version, filename, size and SHA-256 again
after downloading the build artifact. Only that job has release write permission;
it uses GitHub's temporary token, not a stored personal access token.

To inspect packaging locally, set `BYTORIO_RELEASE_TAG` to the intended tag, run
`mise run validate`, then `mise run package:release`. That task only writes and
verifies `build/releases/<tag>/`; it does not publish. Do not run the publisher
without `--check` unless you intend to publish an existing remote tag.

Published versions must never be replaced. Existing releases cause publication
to fail instead of overwriting assets. If an interrupted upload leaves a draft,
inspect it before removing the draft and rerunning the failed workflow; never
delete a published release to retry. Validation logs and packaged assets are
retained as workflow artifacts. Enable immutable releases in repository settings
for additional protection; this workflow does not change that setting.

Downloads use exact tagged URLs under the project's GitHub Releases, with bounded
sizes, a timeout and SHA-256 verification against the HTTPS manifest. Checksums
detect corruption; the manifest's authenticity currently relies on GitHub HTTPS
and repository access controls, not an independently verified signature.

The cache defaults to `~/.cache/bytorio/sdk/<version>`; `BYTORIO_CACHE_DIR`
overrides its root. Cache entries contain both the manifest and compressed asset
and are verified on each use. Installs publish one complete file atomically after
validation, so partial downloads are never reused. Invalid entries fail with a
path to remove explicitly; another cached version stays usable. Downloads are
shared across projects and retained when projects are deleted.

`test:cli` includes local HTTP release fixtures, two simultaneous SDK versions,
concurrent requests, cache corruption, failed downloads, invalid metadata and
compiled offline scaffolding for both languages. Live GitHub download validation
is recorded separately from the fixture tests.
