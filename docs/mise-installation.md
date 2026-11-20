# Advanced mise installation

For ordinary installation, use the [one-line pinned entry](getting-started.md#install-with-mise).
This guide covers optional automatic updates, checksum locks and an SDK task.
Choose CLI and SDK versions from the [releases page](https://github.com/ctxshift/bytorio/releases).

## Follow new CLI releases automatically

Unlike an exact `byt-v...` tag, `latest` needs options to distinguish CLI and SDK
releases and include previews. Save the
[automatic-update recipe](https://raw.githubusercontent.com/ctxshift/bytorio/main/install/mise.toml)
as `mise.toml` in your game folder or an empty tools folder, or merge this
configuration into your existing file:

```toml
[tools."github:ctxshift/bytorio"]
version = "latest"
version_prefix = "byt-v"
prerelease = true
# Include newly published previews; this applies only to this tool.
minimum_release_age = "0d"

[tasks."sdk:install"]
description = "Cache an exact SDK bundle version: mise run sdk:install -- <version>"
run = "byt sdk install"
```

Run `mise trust`, then `mise install github:ctxshift/bytorio` and
`mise exec -- byt --version` from that folder.

`version_prefix` keeps SDK releases out of CLI selection, and `prerelease`
includes previews. `minimum_release_age = "0d"` allows newly published releases
immediately rather than applying mise's release-age delay. These options use
mise's [built-in GitHub backend](https://mise.jdx.dev/dev-tools/backends/github.html).
Choose a CLI release that includes the platform-named `.tar.gz` archives. They
keep the executable name intact during extraction and support older mise asset
detection. The short pinned entry needs none of the automatic-update options
above. The examples do not declare a minimum mise version.

For a CLI-only setup, this command installs the CLI and writes a pinned tool entry:

```sh
mise use --pin 'github:ctxshift/bytorio[version_prefix=byt-v,prerelease=true,minimum_release_age=0d]@latest'
mise exec -- byt --help
```

## Lock and update the installed CLI

For either the short pinned entry or the automatic-update recipe, record
download URLs and checksums for all three supported platforms:

```sh
mise lock --platform windows-x64,macos-arm64,macos-x64 github:ctxshift/bytorio
mise install --locked github:ctxshift/bytorio
```

Keep `mise.toml` and `mise.lock` with your project for repeatable installs. To
update a full-tag pin, choose a new `byt-v...` release and run
`mise use github:ctxshift/bytorio@byt-v<version>`, then refresh the lock. If the
configured version is `latest`, use `mise lock --bump github:ctxshift/bytorio` to
advance the locked version, review its checksums, then install again.

To turn the automatic-update recipe into an exact pin, run
`mise use --pin github:ctxshift/bytorio@latest` and refresh the lock. Its
`version_prefix` option lets mise store the numeric version. A short entry
without that option must keep the full `byt-v...` tag.

## Install an SDK bundle

The optional task delegates to the CLI's verified SDK installer. Replace
`<sdk-version>` with the version of an SDK bundle release, omitting `sdk-v`:

```text
mise run sdk:install -- <sdk-version>
mise exec -- byt new pinned-game --sdk <sdk-version> --offline
```

The CLI checks the bundle's manifest and SHA-256 and caches it for offline use.
For current SDKs the task caches verified metadata; tools and players download
on the first check/build/run that needs them. Keep `bytorio.toml` and the generated
`bytorio.lock.toml` with the source. Normal creation selects a compatible installed
SDK or discovers one online. Use `byt sdk upgrade` for an explicit pin change.
SDKs are managed by `byt`; they need no other mise backend or tool entry.
