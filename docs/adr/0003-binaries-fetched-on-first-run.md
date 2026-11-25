# Binaries fetched on first run, not shipped in the plugin

The `tweak` binaries (five platforms, about 8 MB each) are attached to each GitHub Release and are not in the repo or the plugin. The plugin ships a small launcher with the release's version and a `checksums.txt`. On first run the launcher downloads its platform's binary, checks its SHA-256, and keeps it in `~/.local/state/codaset-tweak/bin/<version>/`. A Claude Code plugin from a git marketplace is installed by cloning the repo, so shipping the binaries in the plugin means committing about 40 MB to git on every release, and every clone downloads all of it, forever.

## Considered Options

- **Committed on `main`** under `plugins/codaset/dist/`. This is the simplest: nothing to download at run time, works offline from install. But `main`'s history grows by about 40 MB a release, and every marketplace clone downloads that history.
- **A `release` branch** that CI writes, holding only the marketplace and plugin files with the binaries; users add `codaset/tweak#release`. This keeps `main` source-only, but the release branch still grows by about 40 MB a release. Squashing it would mean force-pushing a branch Claude Code pulls.

## Consequences

- The first `tweak` command after an install or update needs a network connection and `curl` (PowerShell on Windows), and takes a second or two longer. Every later run starts the kept binary directly.
- The repo and the plugin cache stay small; `main` holds only source.
- A release must publish its GitHub Release before the commit that changes the plugin's version, or a user could update to a launcher whose binary doesn't exist yet. The release workflow enforces that order.
- The binary lives at a path that doesn't change when the plugin updates, which a long-lived bridge needs anyway. Removing old versions is part of [Installation: stable paths across plugin updates](https://github.com/codaset/tweak/issues/16).
- The checksums are written by the release workflow and travel in the plugin, so a tampered or truncated download is refused.
- Working on Tweak itself needs `TWEAK_BIN` to point the launcher at a local build.
