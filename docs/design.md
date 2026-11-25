# Codaset Tweak: design

Status: agreed design for v1 (2026-11-25). A prototype validated the core loop; it lives on the
`prototype` branch of `~/dev/ui-notes`.

## What it is

On your dev server you point at any element, write a **tweak**, and the Claude Code session that
claimed that page makes the **change**. You watch it happen in a card pinned to the element, and you
can undo it. It works with any web application, without changes to that application.

## Vocabulary

- **tweak**: what you leave on the page. A request, with a conversation, a status and a result.
- **change**: what Claude makes in the code for a tweak. Undo reverses a change.
- **claim**: a session's ownership of a set of pages, given as a URL pattern.
- **brief**: everything Claude receives about a tweak: the request, the elements, where their source
  lives, and their styles and markup.
- **mapper**: a module that finds source locations for an element from one kind of clue (React dev
  metadata, Rails template comments, and so on).

## Names and places

| Where | Name |
|---|---|
| Product and store listing | Codaset Tweak |
| Licence | MIT |
| Repo | `~/dev/tweak` locally, `codaset/tweak` on GitHub |
| Claude Code plugin / skill | `codaset` / `tweak`, so `/codaset:tweak` and `/tweak` |
| Local state | `~/.local/state/codaset-tweak/` |
| npm, if ever needed | `@codaset/tweak` |

Audience: v1 is for the author and their team. A public release follows if it proves itself on the
Harley Therapy apps (Bert and Ernie). v1 has no docs site, onboarding or support. Nothing in v1 may
block a public release.

## Pieces

```
Chrome extension  ──HTTP (127.0.0.1)──>  tweak bridge (Go, SQLite)  <──CLI──  Claude Code session
  overlay, pins,                           tweaks, claims, patches,           /tweak skill,
  card, side panel                         inbox, screenshots                 Monitor watcher,
                                                                              undo hook
```

### Chrome extension

- Manifest V3, plain JavaScript and web platform features, no UI framework, no build step.
- Loaded unpacked from the plugin's folder in v1. `/tweak` warns when the loaded extension is older
  than the plugin ("reload it in `chrome://extensions`"). The Chrome Web Store comes later.
- Activates only on pages matching an active claim, learned from the bridge, by registering content
  scripts at runtime. A claim on a new dev domain (e.g. `*.test`, `lvh.me`) asks Chrome for host
  permission once. Unclaimed pages are left untouched apart from the toolbar badge.

### The `tweak` binary (Go)

One binary, three roles:

- **bridge**: an HTTP server on `127.0.0.1` with SQLite storage (pure-Go `modernc.org/sqlite`, no
  cgo). Holds tweaks, claims, change patches, the inbox and screenshots.
- **CLI**: the commands the skill runs (`start`, `claim`, `release`, `watch`, `status`, `reply`,
  `undo`, ...). Every command the skill uses goes through this binary, so a single `allowed-tools`
  rule covers it.
- **hook**: `tweak hook pre-edit`, the undo hook (see Undo).

Built for macOS arm64 and Intel, Linux x64 and arm64, and Windows x64 (about 8 MB each), all shipped
in the plugin behind a small launcher that runs the right one. Windows is marked untested until
someone runs it there.

The bridge and the extension share one JSON schema for every message (`schema/`), and both sides
have contract tests against it.

### Plugin

The `codaset` plugin, from a marketplace in this repo, contains the `tweak` skill, the binaries and
launcher, the hook registration, and the extension folder.

### Delivery to Claude

Only through the skill and Claude Code's **Monitor** tool. The skill starts a Monitor running
`tweak watch`, which long-polls the bridge's inbox and prints one line per event. Each line arrives
in the session as a Monitor event, which starts a turn in an idle session (verified in the
prototype). The skill re-arms the Monitor when it expires (at most every 30 minutes).

There is no channel launcher. MCP Events
(https://modelcontextprotocol.io/extensions/events/overview) gets added as a second delivery route
once Claude Code supports it. Claude Code 2.1.332 does not.

### Bridge lifetime

The first `/tweak` starts the bridge in the background, detached from any session. Later sessions
reuse it. It quits after 30 minutes with no claims and no browser connected. Nothing is lost, since
state is in SQLite. It is not a launchd service.

### Storage

SQLite at `~/.local/state/codaset-tweak/tweak.db`, with screenshots beside it. Resolved tweaks, their
patches and screenshots are deleted 7 days after resolution.

### Security

- Listen on `127.0.0.1` only.
- Every HTTP request carries the custom header `x-tweak: 1`. A web page cannot send it to
  localhost without a CORS preflight, which the bridge never approves.
- The WebSocket (which can't carry custom headers) is accepted only from the extension's exact
  origin, `chrome-extension://<id>`. The manifest pins a `key`, so the ID is the same for every
  install, and the binary knows it.
- Refuse requests with a web `Origin`. Only `chrome-extension://` origins, or none for the CLI, are
  accepted.
- Check the `Host` header is `127.0.0.1:<port>` or `localhost:<port>`. This blocks DNS rebinding,
  where a hostile page makes itself same-origin with the bridge.
- Content inside a brief that came from the page (text, HTML, class names) is presented to Claude as
  data describing the element. Only the tweak's text is the developer's request.

### Bridge contract

Decided in [Bridge contract: API, message schema and data model](https://github.com/codaset/tweak/issues/9).

- **Finding the bridge**: fixed default port **47391**, overridable with `TWEAK_PORT`. The CLI reads
  `~/.local/state/codaset-tweak/bridge.json` (port, PID, version) to find a running bridge. The
  extension tries the default port, with a port field in the side panel.
- **Extension ↔ bridge**: one WebSocket (`/ws`) from the service worker, kept awake by a keepalive
  every 20 seconds (documented since Chrome 116; checked first while building, long-polling as the
  fallback). The worker relays to tabs. Screenshots are uploaded separately over HTTP
  (`PUT /tweaks/:n/screenshot`, PNG) after the tweak is created, and stored as files beside the
  database.
- **CLI ↔ bridge**: plain HTTP. Every request carries `x-tweak: 1`, `x-tweak-protocol: <n>` and the
  session ID. Endpoints: `POST /sessions` (register and check in), `GET/POST/DELETE /claims`,
  `GET /inbox?after=<seq>` (long-poll; one line of at most 500 characters per event) and
  `POST /inbox/ack`, `GET /tweaks/:n/brief` (text), `POST /tweaks/:n/status`, and
  `POST /edits/before` (record a file's contents before an agent edits it; the bridge decides which
  tweak it belongs to). Command names and event-line format are decided in
  [The tweak CLI and the /tweak skill](https://github.com/codaset/tweak/issues/10).
- **WebSocket messages**: to the bridge `hello {protocol, lastSeq}`, `create`, `reply`, `resolve`,
  `undo`; from the bridge a snapshot or events, and refusals.
- **Event log**: the bridge keeps current state plus an append-only event log with a monotonic
  sequence. Clients remember the last sequence seen and get everything newer on reconnect, or a
  fresh snapshot if too far behind. Inbox acknowledgement and redelivery use the same log.
- **Versioning**: one integer protocol version, in the WebSocket `hello` and every CLI request. The
  bridge accepts only its own and refuses anything else with a clear message ("This extension
  speaks protocol 2; the bridge speaks 3. Reload the extension."). No negotiation: binary, extension
  and plugin ship together.
- **Schema**: JSON Schema files in `schema/` plus a folder of example messages are the source of
  truth. Go and JavaScript tests both check against the examples. No code generation.
- **Not tied to one agent**: a session records which agent it is (`agent: claude-code` in v1). The
  CLI takes the session ID from the agent's environment (`CLAUDE_CODE_SESSION_ID`) or `--session`.

**Tweak numbers** are bridge-wide and permanent: "Tweak 12" on pins and cards, `12` in the CLI.

**Statuses** and who sets them:

| Status | Set by | Shown as |
|---|---|---|
| `sent` | bridge, on creation and after your reply | Waiting for a session |
| `delivered` | bridge, when the watcher acknowledges | Claude has it |
| `queued` | Claude, only when finishing other work first | Queued |
| `working` | Claude, with its plan | Claude is working on it |
| `question` | Claude | Claude has a question |
| `done` | Claude, with its summary | Change saved |
| `declined` | Claude, with its reason | Declined |

**Resolved** is separate from status: you've finished with the tweak, and its pin leaves the page.
A change has its own state: `recorded`, `undone` or `undo-requested`.

**Conversation entries**: `{from: you|claude, kind, text, at}`, where kind is `request`, `plan`,
`question`, `reply`, `summary`, `reason` or `undo`.

**Data model (SQLite)**:

| Table | Key fields |
|---|---|
| `sessions` | id (agent session ID), agent, folder, label, last check-in |
| `claims` | id, session, pattern, created |
| `tweaks` | number, session, page URL, status, resolved at, created/updated, targets (JSON), click anchor, screenshot path |
| `entries` | tweak, from, kind, text, at |
| `changes` | tweak, file, contents before, patch, state |
| `events` | sequence, type, tweak or claim, payload (JSON), at |
| `deliveries` | session, last acknowledged sequence |

Targets (elements, selected text, area, with their context) are JSON, shaped by
[Mapper interface and the brief](https://github.com/codaset/tweak/issues/13).

### No lost tweaks

The inbox is acknowledged: `tweak watch` confirms each event after printing it, and the bridge
redelivers anything unconfirmed when a watcher reconnects.

## Claims

- `/tweak <URL>` claims pages for this session. The URL is required.
- Patterns use Chrome's **match pattern** syntax (scheme, a host with an optional leading `*.`, a
  path where `*` matches anything), e.g. `https://*.bert.localhost/*` or
  `https://ernie.localhost/admin/*`. A bare origin means the whole site (`/*`). The extension uses a
  claim's pattern as-is for its content-script registration, and the bridge matches and checks
  overlaps exactly in Go. (Chosen over `URLPattern`, which Go lacks and Chrome's registration API
  doesn't accept.) Port support in match patterns is to be confirmed while building.
- Overlapping claims are refused. If any URL could match both an existing claim and the new one, the
  new claim is rejected, and the message names the pattern and session holding it. Every page has
  exactly one owner.
- A claim lapses after about 60 seconds without its watcher checking in, or at once with
  `/tweak release`.
- `/tweak` with no URL lists current claims and their sessions, and claims nothing.
- On an unclaimed page, the toolbar badge shows a grey `!`. The side panel says no session claims
  the page and offers the `/tweak <this page's origin>` command to copy.

## Pointing at things

- **Pick an element**: hold ⌥ and click, or toggle pick mode with the toolbar button or **⌥⇧C**. The
  click is swallowed so links and buttons don't fire. A hover outline is labelled with the element
  and its source where known.
- **Several elements**: **⇧-click** adds elements, numbered. One tweak covers them all; each
  element's context is numbered to match, and the pin sits on element 1.
- **Text**: select text, then tweak it ("reword this"). Claude gets the exact selected text.
- **Area**: drag a box over any region, including empty space ("put a button here"). Claude gets the
  box, the elements inside it, and the screenshot.
- **Modal dialogs**: while a modal `<dialog>` is open, the overlay host moves inside it, so the
  dialog making the rest of the page inert doesn't block the overlay.

## Finding the source

No changes to the application are needed, and the overlay never runs application code.

Mappers, each behind a small shared interface (an element in, source locations out), in priority
order. Where a mapper gives exact locations, they lead the brief.

| Mapper | Clue | Needs |
|---|---|---|
| React | `_debugSource` (React 18: absolute path, line, column); `_debugStack` (React 19: an `Error`; frame 1, after `jsxDEV`, is the JSX call site in the served module, mapped through its source map) on fibers, read in the page's own JS world | A React development build |
| Vue 3 | the owning component's `type.__file` (absolute path, no line) | A Vue development build |
| Svelte | `__svelte_meta.loc` (project-relative file, line, column; Svelte 4 lines are 0-based), and `parent` for the usage site in Svelte 5 | A Svelte development build |
| Rails templates | `<!-- BEGIN/END path -->` comments, balanced | `annotate_rendered_view_with_filenames` (an app setting, never required) |
| Proscenium CSS modules | class names like `name_hash_app-components-x-module` | Proscenium's dev naming |

Verified on Vite dev builds (React 18.3.1 and 19.2.0, Vue 3.5, Svelte 4.2 and 5.59): see
[Framework dev metadata](https://github.com/codaset/tweak/issues/5). Path forms differ (absolute,
project-relative, dev-server URL) and are normalised to project files.

- **Source maps**: compiled CSS rules and JavaScript stack frames (React 19's `_debugStack`) are
  mapped back to original files and lines through the dev server's source maps.
- **Search clues, for everything else**: the brief lists the element's distinctive strings, most
  distinctive first: exact visible text, unusual class names and IDs, `aria-label`, placeholder,
  test IDs (`data-testid`, `data-test`, `data-qa`, `data-cy`), link targets. Common utility classes
  are left out. When there are no exact locations, the brief says "find the source with these", and
  Claude searches the project itself. The bridge does no searching in v1 (see Open measurements).
- **Optional improvements**: when a page lacks an easy improvement (e.g. a Rails app without
  template annotations), the side panel suggests it once, and it can be dismissed. The app is never
  changed automatically.
- Angular, Solid and Lit mappers come later.

### Context per element

The element's label and a CSS selector, matching CSS rules with their source locations, key computed
styles, size, trimmed HTML, nearby text, accessibility role and name, test IDs, and the viewport.

### Screenshot

Captured for every tweak: the visible area around the element or elements plus a margin, with them
outlined, at most 1600px, saved as a PNG beside the database. The brief gives its path and says to
view it when the request is about how something looks. Claude decides per tweak, so a text change
costs nothing extra.

## Claude's side

- ~~The Monitor event carries the full brief, so Claude never spends a step fetching it.~~ Not
  possible: Monitor caps a line at 500 characters and a notification at 3000
  ([Monitor limits](https://github.com/codaset/tweak/issues/3)). The event is a short pointer, and
  how Claude fetches the brief in the fewest steps is decided in
  [The tweak CLI and the /tweak skill](https://github.com/codaset/tweak/issues/10).
- The card shows "Claude has it" as soon as the watcher receives the tweak. A short plan from Claude
  naming the file it's editing is optional.
- Statuses: **Sent** (waiting for a session) → **Queued** (delivered while Claude is busy) →
  **Working** → **Question** (waiting for your reply) / **Done** / **Declined** (with a reason, e.g.
  "this text comes from the CMS"). Declined is never shown as success.
- At minimum, two Claude steps per tweak: edit, then done. Nothing the skill runs causes a
  permission prompt.
- If a tweak arrives mid-task, Claude finishes its current step, handles the tweak, then resumes.
- Changes are never committed automatically.

## In the browser

### Live card

Opens when you send a tweak, in place of the composer, and stays open until **esc** or **×**.
Clicking around the page leaves it open. It shows the status, Claude's plan, any question with a
reply box, and the summary. It reopens in place after a reload.

### Pins

- One per tweak, at the point you clicked, coloured by status. Resolved tweaks leave the page.
- Fade and let clicks pass through while you pick an element.
- **⌥⇧H** hides or shows them. The setting is remembered per site. While hidden, the card for a tweak
  you just sent still opens, Claude's questions still pop up, and finished tweaks show a toast.
- Pins re-attach by selector after a reload. A pin whose element is gone is listed in the side
  panel.

### Toolbar button

- Click toggles pick mode (same as ⌥⇧C).
- Badge: the number of open tweaks on this page, coloured by the most urgent (blue question, amber
  working, purple sent), or a grey `!` when no session claims the page.
- Works best pinned to the toolbar. The shortcuts work either way.

### Side panel

Opened from the toolbar button's context menu or **⌥⇧N**:

- show or hide pins
- resolved tweaks, with Undo
- claim status, with the `/tweak` command to copy
- the per-site reload setting
- connection status, and the extension version warning
- optional-improvement suggestions

### Reloading after a change

The extension doesn't need to know whether the dev server reloads by itself. After a change it waits
briefly and reloads only if the page hasn't already. A per-site setting in the side panel turns
auto-reload off. The reload is held back, and the card shows "Change saved · Reload" with the reason,
while any of these is true:

- a form on the page has unsaved input
- a dialog or popover is open
- you're drafting a tweak or a reply
- another tweak on this page is still in progress (the reload waits for the last one)

## Undo

- A Claude Code `PreToolUse` hook (`tweak hook pre-edit`) runs before Claude's file edits. While a
  tweak is being worked on in that session, it saves the file's current content, labelled with the
  tweak.
- On done, the bridge stores the exact patch between those saved copies and the files now.
- Undo, from the side panel, reverses the patch at once without involving Claude. If later edits
  make it conflict, the undo goes to the session as a request for Claude to resolve.
- Edits Claude makes through shell commands (e.g. `sed`) aren't captured. The card says so when a
  change has none recorded.

## Testing

Test behaviour where it lives.

- **Bridge**: `go test` against a real bridge on a random port with a temporary database. Tests
  never touch a developer's live bridge or sessions (the prototype once sent a test note to a live
  session).
- **Message schema**: contract tests on both the Go and JavaScript sides.
- **Extension**: end-to-end in headless Chrome against fixture apps. Each checks that clicking an
  element yields the right source location or search clues:
  - plain static HTML
  - Rails without annotations
  - Vite + React 19 (plus a React 18 case)
  - Vite + Vue 3
  - SvelteKit
  - a server-rendered app with no framework clues (e.g. Django templates), relying on search clues
- **Manual**: a final check on Bert (`london`, Phlex + Proscenium) and Ernie (`platform`, React 18 +
  ERB + ViewComponent).

### Open measurements

During v1 testing, time each tweak from delivery to Claude's first edit. If finding the source turns
out to be the slow part, add a project search to the bridge (Go, `.gitignore`-aware, capped at about
200 ms) that puts candidate files in the brief.

## Before building

- Read Handle (https://github.com/tonkotsu-ai/handle, MIT): code can be reused with credit.
- Read Agentation (https://github.com/benjitaylor/agentation) for ideas only, copying no code: its
  licence has a non-compete clause that a competing tool would breach.
- Check whether Proscenium or Rails already reload the page when files change.
- Confirm a plugin skill can be invoked as plain `/tweak` as well as `/codaset:tweak`.
- Verify the Vue 3 and Svelte dev metadata, and React 19's `_debugStack` plus source-map route, on
  real dev builds.

## Not in v1

- freezing animations and timers (next version)
- voice input
- a list of tweaks across all pages
- intent and severity labels, output detail levels, freehand drawing, design mode
- the channel launcher
- the bridge as a launchd service
- the Chrome Web Store, and a docs site
- Chrome's debugging interface (shows a permanent "is debugging this browser" bar); possibly later
  as a per-site opt-in
- a project search in the bridge, unless the open measurement calls for it
