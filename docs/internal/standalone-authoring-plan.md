# Standalone authoring implementation plan

Status: the first source-free authoring release is published. The public runtime,
production player and touch controls remain planned under the
[specification](standalone-authoring-spec.md). Current installation and usage are
in [Getting started](../getting-started.md); [CLI distribution](cli-distribution.md)
retains the original scaffolding design for compatibility.

[CLI 0.2.0-preview.1](https://github.com/ctxshift/bytorio/releases/tag/byt-v0.2.0-preview.1)
and [SDK 0.2.0-preview.3](https://github.com/ctxshift/bytorio/releases/tag/sdk-v0.2.0-preview.3)
provide new/check/build/pack/run/dev and explicit SDK upgrades without a source
checkout or global compiler. The [SDK release qualification](https://github.com/ctxshift/bytorio/actions/runs/40535242300)
passed all 39 gates on Windows and Apple Silicon, Intel CLI checks, and clean
consumers using the exact assembled SDK on all three hosts. The
[CLI release](https://github.com/ctxshift/bytorio/actions/runs/40542264014) passed
its host gates and published matching binaries and archives.

[Published installation qualification](https://github.com/ctxshift/bytorio/actions/runs/40546668003)
passed all nine jobs: fresh mise installs and source-free authoring on Windows,
Apple Silicon and Intel, plus mise 2025.12.0 and 2026.7.0 on each host. Both
languages run on Windows and Apple Silicon; Intel supports Luau/browser play.
The downstream installer guard now explicitly tolerates skipped SDK-only
ancestors while requiring successful CLI publication. This release's installer
was dispatched explicitly after publication. The
[live getting-started guide](https://bytor.io/docs/docs/getting-started.html)
uses evergreen release links and the short mise pin.

The SDK backend now includes isolated compiled-CLI checking, verified component
archives and shared cache, installed-first compatibility selection, SDK-owned
authoring and explicit source/release adapters. Host-specific candidates contain
managed Luau/Odin tools, check workers, executor and prebuilt web/native players.
Their consumer check runs outside the checkout with an empty PATH, reuses cached
components offline, deletes that cache, then plays relocated exports in both
languages. It also verifies copied Mac signatures and compares native/browser
smoke output. Contributor source commands use the same authoring implementation.

The release workflow now assembles host candidates and qualifies the exact
result with the compiled CLI on each supported host before SDK publication.
Intel Mac contributes a Luau analyzer and consumes canonical shared bytes;
Odin/native support remains Windows and Apple Silicon. The released
CLI now creates minimal TOML projects with exact SDK pins, installed-first
preview selection and offline reuse. The compiled CLI routes check, build, pack,
run and dev through the selected SDK. Builds publish complete owned outputs,
browser previews use isolated snapshots, and dev reloads after successful edits
while retaining the working game after errors. Explicit SDK upgrades update the
generated pin without rewriting authored configuration. Confirmed
defaults are `bytorio.toml` plus `bytorio.lock.toml`, previews eligible, and
web-only builds with native selected explicitly. Public runtime extraction, production player and
touch controls and automatic migration remain later steps. The first release
deliberately ships the existing player, as agreed.

Full candidate production targets Windows x64 and macOS Apple Silicon. The Intel
producer builds and signs its Luau analyzer from the executor's same immutable
source revision; the upstream Mac analyzer download is ARM-only. Intel has no
Odin/native capability. Assembly selects one canonical set of shared payloads;
consumer qualification checks that assembled manifest rather than assuming
independently produced common archives have identical bytes.

`assemble:sdk-release` now merges verified host candidates, checks matching
contracts and host ownership, selects canonical common bytes, and validates all
published entrypoints and executable modes. It rejects conflicting assets or
corrupt archives, reserves its output exclusively, and writes metadata last.
The isolated SDK consumer test exercises this assembled output. Published assets
passed cross-host qualification, offline reuse, failed-edit recovery, automatic
browser reload and relocated playback after cache removal.

The [backend qualification run](https://github.com/ctxshift/bytorio/actions/runs/40472926173)
passed all 39 gates on Windows x64 and Apple Silicon, plus the Intel Mac CLI
gate. The complete local 39-gate validation also passed at that functional
revision. The later release and published-installation runs above establish the
public authoring cutover. Public runtime/player embedding acceptance remains
separate work.

## Working approach

Deliver small, usable slices through the standalone CLI and a versioned SDK.
Preserve contributor source builds as an explicit adapter. Keep one production
authoring implementation behind the CLI interface rather than maintaining
divergent compiled/source command implementations.

Use the existing mise/JavaScript workflow and pinned tools. Run focused checks
during each slice, then the complete required gates for meaningful behavior
changes. Retain actual reports and distinguish local, fixture and release tests.
Documentation work alone does not require rebuilding the runtime.

## Current implementation and migration seams

| Existing location                                   | Current responsibility or constraint                                                        | Required change                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `tools/cli/main.ts`                                 | Compiled preview supports `new` and `sdk install`; other authoring commands fail explicitly | Route standalone commands through the shared authoring interface                        |
| `tools/cli/sdk-bundle.ts`                           | Protocol-1 text bundle download/cache and SDK-only pin                                      | Add versioned component resolution without breaking old bundles                         |
| `tools/sdk/scaffold.mjs`                            | Generates config, assets, editor settings and SDK editor copies                             | Reduce primary project files and use selected-SDK starter/default metadata              |
| `tools/sdk/project.mjs`                             | Contributor adapter resolves source SDK/tools and builds players through mise               | Preserve explicit source builds while the CLI uses the released SDK adapter              |
| `tools/sdk/authoring.mjs` and `tools/cli/released-sdk.mjs` | Shared authoring module and verified release adapter for libraries/tools/checkers/players | Connect the public project commands and produce qualified release components             |
| `tools/sdk/bundle.mjs`                              | Bundles matching contracts/constants and emits source without external formatters           | Package this implementation with each selected SDK                                     |
| `tools/sdk/check.mjs` and `smoke-worker.mjs`        | Supervised check process with explicit worker, cartridge and Wasm paths                     | Resolve worker and policy payloads from the selected SDK                                |
| `tools/player-export.mjs`                           | Builds/stages repo-relative player inventories and invokes author-side signing              | Split release production from copying verified, relocatable SDK payloads                |
| `runtime/odin/web/player.js`                        | Mixes page UI, input, audio startup, scheduling and worker ownership                        | Extract the public browser runtime; build the default player on it                      |
| `runtime/odin/web/worker.js` and supporting scripts | Existing execution, rendering, audio, content and host behavior                             | Preserve internals/contracts while exposing a supported runtime interface               |
| `site/` and example staging                         | Customize copied player markup and host controls                                            | Consume the public modules/configuration rather than private markup rewriting           |
| `tools/build-sdk-release.mjs` and release workflow  | Publish source-library SDK bundles and standalone CLI previews                              | Produce, qualify and publish version-matched runtime/player/tool components             |
| `tools/sdk/produce.mjs` and `build:sdk-components` | Produce host-specific Luau/Odin, check, web and native candidates with explicit CLI compatibility | Add cross-host assembly and release publication after qualification |

This is an implementation map, not a requirement to retain every filename.
Audit imports, generated constants, `repo`/cwd assumptions, tool discovery,
worker URLs and signing during extraction; replacing one top-level path is
insufficient.

## Milestone 0: settle the contracts and record the baseline

Dependencies: none.

- Review the open decisions in specification section 12. Resolve project and
  lock schemas, release eligibility and advertised target scope before freezing
  their interfaces. Keep external framework-server coordination separately
  scoped if the preference is still unanswered.
- Define the distribution manifest, CLI compatibility rules, starter metadata,
  SDK component inventory and cache/dependency identities.
- Define the public browser runtime capabilities and the default player's
  supported configuration/extension interface. Use the runtime/player terms
  from the spec consistently; engine replacement is not part of the work.
- Inventory current cartridge/profile/input/save/audio/timing contracts and
  independent replay expectations. Preserve the selected SDK's policies instead
  of importing the newest repository constants into every game build.
- Probe packaged Worker and Wasm execution in the compiled CLI. Resolve Bun
  host compatibility before assuming the Node smoke worker can be copied as-is.
  A required helper must be managed by the SDK, not supplied by a global Node
  installation or a source checkout.

Exit: reviewed schema/interface drafts, explicit support gaps, a packaged-checking
proof, and named acceptance tests for each slice. Do not rename config fields or
silently map legacy `console.json.sdk` values to distribution releases.

The packaged-checking qualification is `mise run validate test:cli-worker`.
It relocates a compiled executable and SDK-style worker/Wasm payloads outside
the checkout, clears PATH and runtime/tool environment variables, and exercises
real Odin/Luau games, malformed guests and an infinite Wasm loop. It also checks
the contributor adapter against the same payloads. This gate requires the
contributor build tools only to produce its fixture payloads; the relocated
consumer process uses none of them. It runs in the full Windows/Apple Silicon
gates. Intel Mac qualification must consume prebuilt SDK payloads separately,
because that host cannot produce the Odin fixtures with the pinned toolchain.

## Milestone 1: versioned SDK components, cache and minimal creation

Dependencies: milestone 0.

- Extend release production with a new manifest protocol and separate component
  payloads. Reuse the existing qualified player inventory initially; SDK
  production may build from the repository, game authoring may not.
- Preserve protocol-1 scaffolding/cache support and immutable existing releases.
  Report missing full-authoring capabilities explicitly.
- Implement installed-first selection, compatible release discovery, exact pins,
  preview policy and explicit upgrades. Starter metadata must be available
  without downloading players or compilers.
- Implement shared cache/component verification, bounded extraction, concurrent
  requests, atomic publication and interruption/corruption recovery.
- Evolve the dependency record for manifest/component digests and cross-host
  portability. Keep release identities separate from cartridge SDK/API versions.
- Generate `src/main.*` and the small root config from the selected starter.
  Supply default assets from the SDK; make editor metadata generated/portable.

Exit: relocated compiled CLI creates both language projects using local HTTP
release fixtures and cached real bundles, selects correctly with multiple
installed SDKs, and performs no player/compiler downloads during creation.
Tests cover explicit versions, no-compatible-SDK cases and offline reuse.

`mise run build:sdk-components <version> '<CLI SemVer range>'` produces a
host-specific candidate under `build/sdk-components`. It includes the real
SDK-owned authoring bundle, libraries and shared implementation packages,
Luau analyzer, pinned Odin compiler and Wasm linker, check worker/runtime,
executor and legacy web/native player assets. The consumer qualification uses this same producer and
archive inventory. It refuses an existing output directory and writes its
validated manifest only after all components are complete. This is an internal
candidate path; the published protocol-1 release workflow remains unchanged.
The candidate does not establish the public runtime interface. Host support is
qualified separately; the pinned compiler still excludes Intel Mac Odin builds.

## Milestone 2: first complete standalone Luau/browser slice

Dependencies: milestone 1.

- Introduce the resolved-SDK interface used by the authoring pipeline. Provide
  cached-release and explicit contributor-source adapters at that seam.
- Move Luau checking/bundling/packing to selected-SDK libraries, contracts,
  defaults and managed tools. Remove implicit mise/runtime builds and global
  tool lookups from the distributed path.
- Keep generated source valid and readable without assuming a globally installed
  formatter. Remove unnecessary formatting from mandatory build steps or declare
  any remaining helper as an SDK-managed dependency.
- Package the check worker and required assets for the compiled CLI, preserving
  failure recovery and isolation. Fail clearly for an unsupported SDK capability.
- Implement one-build browser `run`, explicit web build output and cartridge
  packaging using prebuilt SDK payloads. Opening the system browser must not
  require a project script or another JavaScript runtime.

Exit: on a clean qualified host, `new`, `check`, `build`, `run` and `pack` work
for Luau with no Bytorio checkout or global development tools. The initial SDK
player may still have its legacy shell during this internal slice; do not label
the final production-player requirement complete yet.

## Milestone 3: public browser runtime and a custom-player proof

Dependencies: milestone 2; milestone-0 interface review.

- Extract session creation/loading, scheduling, worker communication, presentation,
  audio activation, saves/text/content integration, errors and disposal from
  page-specific UI code.
- Publish a browser-consumable runtime entrypoint and relative asset inventory.
  Keep DOM IDs, page styling, toolbar choices and private messages out of its
  required interface.
- Keep coherent frame metadata separate from the latest simulation state.
  Preserve existing execution/resource limits and independent replay results.
- Add a minimal custom player using only SDK exports and its own HTML/controls.
  It must not import repository files or manipulate the private worker protocol.
- Test two mounted sessions, disposal, failed/stale loads, focus ownership,
  audio activation, saves, text entry and deployment below a URL subdirectory.

Exit: the default host and custom-player proof run the same Luau and Odin
cartridges through the same public runtime interface. The runtime can be
consumed independently of the default-player UI and styles.

## Milestone 4: production default player and digital touch controls

Dependencies: milestone 3; reviewed visual/control design.

- Implement the element-mounted default player with a framed game and compact
  external toolbar. Use the public runtime interface exclusively.
- Move development diagnostics into an opt-in presentation. Retain useful loading,
  playback and recovery messages for normal players.
- Implement D-pad/buttons and tap/drag adapters using existing supported SDK
  input semantics. Do not introduce analog axes or twin-stick work in this slice.
- Define presets, binding/label/layout overrides and an explicit custom-layout
  alternative. Validate configuration and unsupported bindings early.
- Qualify multitouch, pointer capture/cancellation, orientation, safe areas,
  fullscreen, logical coordinates and keyboard accessibility.
- Migrate the website and reference-game hosts to public embedding/configuration
  interfaces. Preserve their supported gameplay, saves and audio behavior while
  removing private markup/DOM dependencies.

Exit: production exports contain the clean default player; development tools can
inspect it separately. Both a customized preset and a fully custom control
layout pass on real phone/tablet browsers as well as desktop automation.

## Milestone 5: managed Odin builds and native SDK players

Dependencies: milestones 1–3; qualified target/toolchain decisions.

- Package compatible Odin compiler/linker/support assets by host and resolve
  them from the selected SDK. Preserve multi-file projects and advanced existing
  cartridge/profile/content configuration.
- Produce native player payloads with required libraries, loaders, signatures
  and notices. Test the exact packaged bytes after relocation.
- Separate contributor staging/signing from author exports: game authors copy
  qualified SDK artifacts and must not need to compile or re-sign the player.
- Implement native run/export using the same cartridge build pipeline and SDK
  selection. Continue to default ordinary playback to the browser.
- Qualify Windows x64 and macOS Apple Silicon; track Intel Mac native player and
  Odin host-compiler support explicitly. Do not change pinned compilers without
  the project's required approval or claim support from CLI-only tests.

Exit: each advertised native/language combination builds and plays from CLI/SDK
artifacts alone. A target without the necessary qualified payload/toolchain is
reported as unsupported, with no source-build fallback.

## Milestone 6: development loop, upgrades and project migration

Dependencies: milestones 2–3 for browser development; milestone 5 adds native
development. The browser loop need not wait for native platform qualification.

- Implement `byt dev` watching, serialized builds and browser reload notifications.
  Watch game source, relevant assets/content, config and custom shell inputs;
  avoid generated-output loops.
- Preserve the last valid playable export when a rebuild fails and recover on
  the next successful edit. Cancel stale results when the project/SDK changes.
- Keep `run` non-watching and define clean session shutdown, port conflicts,
  native child ownership and automation behavior.
- Implement explicit SDK upgrades and a reviewed migration for existing project
  config/lock files. Preserve custom fields and never reinterpret old SDK/API
  numbers or overwrite authored source silently.
- Preserve source-contributor commands and plan compatibility for existing
  `watch`/explicit-directory workflows. Settle aliases/deprecation deliberately.

Exit: two games pinned to different SDKs can develop concurrently, rebuild with
the correct players/tools, and continue working after a CLI upgrade. Offline,
rebuild-error, asset-change and explicit SDK-upgrade scenarios pass.

## Milestone 7: portable custom-site and production exports

Dependencies: milestones 3–4 and the browser work in milestone 6. Native exports
also require milestone 5; custom browser embedding need not wait for them.

- Export runtime/default-player modules and cartridge assets for ordinary static
  hosting without SDK-cache or release-server dependencies at play time.
- Document and test a plain HTML/JavaScript embed and an independently built
  site consuming the runtime directly. No framework is required for the default
  game workflow.
- Make SDK asset locations explicit and relocatable; document secure contexts,
  MIME types, CORS/CSP requirements and host-page lifecycle/input responsibilities.
- Add custom shell support through reviewed public configuration. Coordinating
  an external framework dev server is a separate work item gated by the open
  preference, not an implicit prerequisite for embedding.
- Exercise a representative complex project through configurable entries,
  indexed content and a custom player. Use redistributable/synthetic fixtures;
  do not import another game's assets or machine paths into this repository.

Exit: authors can discard the stock UI, host the SDK runtime within their own
site, and keep using `byt` for cartridge authoring. Default browser/native
exports also run after the authoring cache and checkout are made unavailable.

## Milestone 8: release qualification and cutover

Dependencies: completed capabilities advertised by the release.

- Extend CI from CLI scaffolding checks to clean consumer environments using
  downloaded SDK payloads. Assert that the source checkout and globally installed
  build tools cannot satisfy missing dependencies accidentally.
- Test the host/language/target matrix, multiple SDK pins, cold/warm/offline caches,
  corrupt/interrupted downloads, concurrent operations and paths containing spaces.
- Include public runtime/default/custom-player conformance and mobile/tablet
  acceptance, in addition to existing independent native/browser expectations.
- Build each release artifact once, qualify those bytes, then publish matching
  manifests/checksums/notices. Keep SDK and CLI release versions independent and
  preserve existing CLI archive/mise installation contracts.
- Publish the SDK components before a CLI release or instructions that require
  them. Replace source-fallback getting-started instructions only when the
  corresponding standalone capability passes clean-machine acceptance.
- Update current-status documentation and public examples; retain contributor
  source setup separately. Never describe a scaffolding-only release as full
  authoring support.

Exit: the specification's acceptance criteria pass for every advertised
combination, installation instructions use real releases, and ordinary game
authors need only the CLI and SDK-managed dependencies.

## Review and completion evidence

Each implementation slice should record its delivered capabilities, checks,
artifact identities and remaining supported-platform limits. A local fixture
pass, a source-build pass and a clean released-artifact pass are different evidence.
Keep commits focused and preserve immutable published releases.

This planning change itself requires documentation/link/diff review, not the
runtime validation suite. No runtime, CLI, SDK protocol or released capability
changes merely by adding these documents.
