# Codaset Tweak

Point at any element of your running web app in Chrome, describe a **tweak**, and the Claude Code
session that claimed the page makes the change. You follow it in a card pinned to the element, and
you can undo it. It works with any web app, without changes to the app.

```
Chrome extension  ──HTTP (127.0.0.1)──>  tweak bridge (Go, SQLite)  <──CLI──  Claude Code session
  overlay, pins,                           tweaks, claims, changes,           /tweak skill,
  card, side panel                         inbox, screenshots                 Monitor watcher,
                                                                              undo hook
```

> **Status**: v1 is built and in final manual testing. It is for the Codaset team for now, and has
> no release yet, so the plugin install below works once `v0.1.0` is published. Until then, run it
> from a checkout (see [Trying your changes in your own apps](#trying-your-changes-in-your-own-apps)).

## Install

1. In Claude Code, add the marketplace and install the plugin:

   ```
   /plugin marketplace add codaset/tweak
   /plugin install codaset@codaset
   ```

   The plugin's launcher downloads the `tweak` binary for your platform on first run (macOS arm64
   and Intel, Linux x64 and arm64; Windows x64 is untested) and checks its SHA-256.

2. Run `/tweak <url>` once (below). The first run starts the bridge, which writes the Chrome
   extension to `~/.local/state/codaset-tweak/extension/`.

3. Load the extension in Chrome: open `chrome://extensions`, turn on **Developer mode**, click
   **Load unpacked** and choose `~/.local/state/codaset-tweak/extension` (on macOS the file picker
   hides `~/.local`: press ⌘⇧G and paste the path). It keeps itself at the bridge's version from then
   on.

4. Open the Codaset Tweak side panel and click **Allow access**, once. Without site access ⌥-click
   does nothing.

When the skill offers to add `"Bash(tweak *)"` to your allow list, say yes: it stops later turns
from waiting on a permission prompt.

## Use

In the Claude Code session working on your app:

| Command | Does |
|---|---|
| `/tweak http://localhost:3000/*` | claims the pages matching the pattern for this session and starts listening |
| `/tweak` | lists the current claims |
| `/tweak release [pattern]` | releases one claim, or all of this session's |

Then, on a claimed page in Chrome:

- **⌥-click** an element (or toggle pick mode with the toolbar button or **⌥⇧C**) and write what
  you want changed.
- **⇧-click** adds more elements to the same tweak; select text first to tweak exactly that text;
  **⌥-drag** a box over any area, empty space included.
- Watch the card: **Sent** → **Working** → **Done**, or a **Question** to reply to, or **Declined**
  with a reason. **Undo** on the card reverses the change.
- **⌥⇧N** opens the side panel, **⌥⇧H** hides or shows the site's pins.

Claude gets a brief for each tweak: your request, the elements, their styles and markup, a
screenshot, and where their source lives. It finds the source from React, Vue 3 and Svelte
development builds, Rails template annotations, Proscenium CSS module names and the page's
stylesheets. Changes are never committed for you.

## Uninstall

`/plugin uninstall codaset@codaset` (and `/plugin marketplace remove codaset`), remove the extension
in `chrome://extensions`, and delete `~/.local/state/codaset-tweak/`.

## Working on Tweak

You need Go 1.27, Node 26 (`.nvmrc`) and Chrome for Testing
(`npx puppeteer browsers install chrome`).

```sh
go test -race ./... && go vet ./... && gofmt -l .
npm ci && npm test
npm run e2e                     # headless Chrome against the apps in fixtures/
npm run check:consistency
```

### Trying your changes in your own apps

`make install` makes your local build *your* Tweak: it runs on the usual port and state folder, in
every Claude Code session, with no environment variables and no new session. Set it up once:

1. In any Claude Code session: `/plugin marketplace add ~/dev/tweak`, then
   `/plugin install codaset@codaset`, then `/reload-plugins`. A marketplace added from a local path
   loads the plugin in place, so edits to the skill, hooks and launcher take effect at the next
   `/reload-plugins`, whatever the version says.
2. `make install`: builds the binary, stamped with the plugin's version, into the folder the
   launcher looks in before downloading.
3. In Chrome, load the repo's `extension/` folder unpacked (Developer mode on), then click **Allow
   access** in its side panel. Its port is already the default.

Then `/tweak <url>` in any session, on any app. After a change:

- **Go**: `make install` again. It stops the running bridge; a watcher starts the new one within
  about 10 seconds, and claims carry over.
- **Extension**: click reload on Codaset Tweak in `chrome://extensions`.
- **Skill or hooks**: `/reload-plugins` in the sessions using them.

This is the live Tweak, not an isolated one. The launcher runs whatever is in
`~/.local/state/codaset-tweak/bin/<version>/` for its version and downloads nothing while it's
there, so your build stays until you delete that folder; then the launcher downloads the release.
To switch to the published plugin, `/plugin marketplace remove codaset`, then follow
[Install](#install).

### An isolated development bridge

The e2e suite, and anything that must not touch your live Tweak, runs a development build
(`make build`, which writes `dist/tweak`) through `TWEAK_BIN`. It must have its own port and state
folder, so it never reaches the live bridge:

```sh
TWEAK_BIN="$PWD/dist/tweak" TWEAK_PORT=47400 TWEAK_STATE_DIR=/tmp/tweak-state claude --plugin-dir plugins/codaset
```

Set **Tweak's port** in the extension's side panel to the `TWEAK_PORT` you chose.

`AGENTS.md` has the full working notes; the agreed design is in [`docs/design.md`](docs/design.md),
the vocabulary in [`GLOSSARY.md`](GLOSSARY.md), and decisions in [`docs/adr/`](docs/adr/).

## Licence

[MIT](LICENSE)
