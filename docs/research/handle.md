# Handle: what to reuse

Research for codaset/tweak#7. Source: https://github.com/tonkotsu-ai/handle, shallow clone at commit
`36510552969211e77ada7b32cce8f991c5896d46` (2026-05-08, "Add line height, letter spacing, alignment to
Typography section"). The clone has a single commit (`git rev-list --count HEAD` = 1), so there is no history
to check provenance against. Every `path:line` below is in that clone. Nothing was installed or run; files were
only read. Statements marked **(inference)** are my reading, not something the code states.

## Answer

1. **Licence: MIT, confirmed.** `LICENSE:1` "Copyright 2026 Tonkotsu AI, Inc."; `mcp/package.json:31` `"license": "MIT"` (the only package.json with the field). Reuse needs only that copyright line and the permission text kept with any copy: a `THIRD_PARTY_NOTICES.md` plus a header comment on each derived file. The name, icon and Web Store assets are not covered.
2. **Handle is a different product**: a visual style editor that sends a plain-text property diff plus a selector and component name. No screenshot, HTML, source location, status, reply, pin or agent-side undo. Little to lift whole.
3. **Delivery is a blocking MCP tool (`get_design_feedback`) looped by a `/handle` command file** (`mcp/src/server.ts:278-452`, `mcp/src/agents.ts:32-41, 486-503`); it is a slash command, not a plugin skill. Nothing to reuse; Monitor delivery, claims and acknowledgement are stronger.
4. **Reuse with credit, as JS ports:** the framework probes (`shared/src/utils/dom.ts:176-249`), the capture-phase click swallow plus `elementsFromPoint` hit test (`ext/entrypoints/handle.content.ts:405-406, 695-702`; `dom.ts:147-170`), the optional padding/margin/gap hover overlay (`dom.ts:278-402`), the hydration retry (`handle.content.ts:211-229`), and re-injecting scripts into already-open tabs (`ext/entrypoints/background.ts:52-65`).
5. **Learn from only:** side-panel lifecycle port (`background.ts:75-96`), pid liveness and reconnect grace (`server.ts:41-43, 174-202`), SPA navigation detection (`handle.content.ts:666-692`, with an unverified isolated-world caveat).
6. **Avoid:** Socket.IO `cors: "*"` plus an unauthenticated discovery endpoint, both listening on all interfaces (`server.ts:68-70, 145, 208-211, 224`); likely page-to-agent prompt injection, untested. Also `<all_urls>` injection and analytics.
7. **Design notes:** Handle confirms the Svelte metadata is `__svelte_meta.loc.file` (so line/column sit under `loc`, still to verify) and the `__vueParentComponent` entry point; it never reads Vue `type.__file`, React `_debugSource` or `_debugStack`, so those remain unverified. Nothing contradicts `docs/design.md`.

## 1. Licence

- `LICENSE:1`: "Copyright 2026 Tonkotsu AI, Inc."
- `LICENSE:3`: the standard MIT grant ("to deal in the Software without restriction, including without
  limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies") with
  the condition at `LICENSE:5`: "The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software."
- `mcp/package.json:31`: `"license": "MIT"`. `README.md:99-101` ends with "MIT — see LICENSE". No other package.json
  has a licence field (`package.json`, `ext/package.json`, `shared/package.json`). `ext/package.json` names
  the author "Tonkotsu AI Inc.". I found no `Copyright`, "adapted from" or "based on" comments in any source
  file (grep over `ext shared mcp` returned nothing), so I found no embedded third-party code with its own
  notice. That does not prove there is none, since the history is squashed.
- What reuse needs: keep the copyright line and the permission text with any copy or substantial portion.
  Practical form for Tweak: a `THIRD_PARTY_NOTICES.md` (or a section in `LICENSE`'s companion) quoting the
  Handle notice verbatim, and a one-line header in each derived file ("Portions derived from Handle,
  Copyright 2026 Tonkotsu AI, Inc., MIT; see THIRD_PARTY_NOTICES.md"). Tweak itself can stay MIT.
- Limits of this check: the licence covers the GitHub repo. The Chrome Web Store build, the name and logo
  "Handle", and `gethandle.ai` are not covered by the MIT grant as far as the text shows; MIT grants no
  trademark rights. Do not reuse the name, icon (`ext/public`) or copy.
- Dependencies that would come along if copying UI: `lucide-react`, `react`, `socket.io*`, `@statsig/js-client`
  (`ext/package.json:15-19`). Tweak plans no framework, so none of these apply.

## 2. Architecture

Monorepo of three packages (`package.json` workspaces; `README.md:46-56`).

```
Chrome page                      Extension                              MCP server (stdio, per agent session)
content script ──runtime msgs──> background service worker ──────────>  (none: sidepanel talks to MCP directly)
handle.content.ts                background.ts                          sidepanel ──Socket.IO──> mcp/src/server.ts
                                 sidepanel (React) ◄── discovery poll ── HTTP :58932 /api/sessions
```

- **Extension** (`ext/`, WXT + React 19 + Tailwind, `ext/wxt.config.ts`, `ext/package.json`).
  - Manifest: `host_permissions: ["https://*/*", "http://localhost/*"]`, permissions
    `sidePanel, scripting, contextMenus, storage` (`ext/wxt.config.ts:8-9`). The content script matches
    `<all_urls>` at `document_idle` (`handle.content.ts:13-14`). So it runs on every page, always. (Design
    says Tweak activates only on claimed pages, which is stricter.)
  - **Side panel** is the main UI, not an in-page overlay. `background.ts:23-37` enables a per-tab panel
    (`sidePanel.setOptions({tabId, enabled:true, path:"sidepanel.html?tabId=..."})` then `sidePanel.open`) when
    the toolbar button is clicked or the context menu "Design with Handle" is used (`background.ts:46-50,
    68-72`). A port named `sidepanel:<tabId>` tells the worker when the panel closes, which disables the
    picker (`background.ts:75-86`). On page reload with the panel open, it re-enables the picker
    (`background.ts:89-96`).
  - `ext/components/SidePanel.tsx` (1391 lines) holds element-tree state, edit tracking, the session
    connection and the send action. `shared/src/components/StyleEditor.tsx` (1774 lines) is the property
    editor with sections Layout, Appearance, Fill, Stroke, Typography, Content (`StyleEditor.tsx:1121-1736`),
    plus `ColorPicker.tsx`, `IconPicker.tsx` (Lucide icon swap), `ElementRow.tsx` (hierarchy row).
  - **Picker** lives in the content script (`handle.content.ts`). No Shadow DOM: the highlight is a plain
    `div` appended to `document.documentElement` with `z-index:2147483647` (`handle.content.ts:71-79`), so
    page CSS can in principle reach it **(inference)**.
- **MCP server** (`mcp/`, published as npm `handle-ext`, `mcp/package.json:2`). One tool,
  `get_design_feedback` (`mcp/src/server.ts:278`). It also starts a Socket.IO server on an OS-assigned port
  (`server.ts:66-70, 144-150`), writes `~/.handle/sessions/<id>.json` (`server.ts:21-23, 327-336`), and a
  discovery HTTP server on fixed port 58932 listing live sessions (`server.ts:39, 204-232`). One MCP process
  per agent session (it is spawned on stdio by the agent), which is how Handle "knows" sessions.
- **`/handle` command**: `npx handle-ext init` detects installed agents and (for Claude Code) merges an MCP
  entry into `~/.claude.json` and writes `~/.claude/commands/handle.md` containing the prompt in
  `HANDLE_COMMAND` (`mcp/src/agents.ts:32-41, 486-503`, `mcp/src/setup.ts`). Same prompt is reused for
  Codex, Gemini, Copilot, Rovo Dev and others (`agents.ts:43-75, 454, 473, 539`). Supporting eight agents
  is Handle's distribution strategy; Tweak is Claude Code only so this layer is irrelevant.
- **Tests**: vitest with jsdom for `shared/` and `ext/` (`vitest.config.ts`), including simulated
  async message-passing races (`shared/src/utils/message-flow-race.test.ts`, 672 lines) and an MCP end to
  end script (`mcp/test-e2e.mjs`) that spawns the server and drives it over Socket.IO. No real-browser tests;
  the content script and background are not exercised in Chrome **(inference from `vitest.config.ts`
  includes and file list)**.
- Other: `shared/CLAUDE.md:14-27` describes a sibling Electron app (`handle-app`) that injects the DOM
  helpers as **strings** (`*Snippet` exports at `dom.ts:406-706`) via `executeJavaScript`. Irrelevant to
  Tweak, but it shows `dom.ts` has a duplicated string copy that must be kept in sync.

## 3. Element context captured, and how

**Picking.**
- While design mode is on, `window` capture-phase `click` and `dblclick` listeners swallow the click with
  `preventDefault()` and `stopImmediatePropagation()` (`handle.content.ts:405-406, 432-433, 695-702`). The
  comment at `:699-700` says capture on `window` is chosen "so selection mode wins over page-level document
  capture handlers such as SPA routers". Worth knowing: that is the ordering Tweak's swallow-the-click also
  needs.
- Target = first visible element under the pointer, via `document.elementsFromPoint`, skipping the overlay
  and anything `opacity:0`, `visibility:hidden`, `display:none` or `aria-hidden` (`dom.ts:147-170`).
- `mouseover` (capture) finds the element under the pointer, sets `style.outline = "2px solid #4A90D9"` directly on it, and
  shows the padding/margin/gap measurement overlay for it (`handle.content.ts:336-348`; overlay code `dom.ts:278-402`,
  colours `:278-280`). `mouseout` clears the outline (`:350-359`). The side panel can also trigger the measurement and
  a highlight box by node id (`show-measurements`, `highlight-element`, `handle.content.ts:743-753, 804-815`). The hover
  outline mutates the page's own inline style.
- Text leaves: single click is delayed 250 ms (`DBLCLICK_WINDOW_MS`, `:47`, `:414-424`) to tell it from a
  double-click, which turns the element `contenteditable` for inline text editing, saving and restoring
  `contenteditable`, `spellcheck`, outline and cursor (`:26-41, 470-600`).
- Single element only. There is no multi-select, no text-range selection and no area drag.

**What is captured per element.**
- **Tree**: `buildDomTree` walks `document.body` with caps (depth 25, 3000 nodes, 50 children per node,
  skipping script/style/noscript/link/meta) giving per node: tag, id, classes, owning component, child
  count, a selector path, hidden flag and trimmed text for text nodes (`dom.ts:3-12, 59-145`).
- **Selector path**: `tag#id.class1.class2` segments joined by ` > `, with `:nth-child(n)` added only when a
  sibling has the identical tag+id+classes (`dom.ts:15-48`). Weak: it is not guaranteed unique, and classes are
  not escaped, so Tailwind-style classes like `md:flex` or `w-1/2` produce selectors that are invalid CSS
  **(inference)**. It is a label, not a locator.
- **Component name only**, via `detectComponent` (`dom.ts:176-249`; a second copy in `background.ts:119-186`
  and a third in `:217-284`, all identical logic):
  - React: finds a `__reactFiber$*` or `__reactInternalInstance$*` property on the node and walks
    `fiber.return` until a function/object type with `displayName` or `name` (`dom.ts:176-198`). It stops at
    the first host (string) type, so it returns the nearest component name only. It never reads
    `_debugSource` or `_debugStack` (grep for both returned nothing).
  - Vue 3: `el.__vueParentComponent`, labelled only if `subTree.el === el`; name from `type.name` or
    `type.__name` (`dom.ts:201-206`). It does **not** read `type.__file`, which the design's Vue mapper needs, so that clue is neither confirmed nor refuted. Vue 2: `el.__vue__` with `$options.name/_componentTag` (`:209-213`).
  - Angular dev mode: `globalThis.ng.getComponent(el)` constructor name (`:216-228`).
  - Svelte dev mode: `el.__svelte_meta.loc.file`, takes the basename of `*.svelte`, only on the outermost
    element of a file (`:231-241`). This **confirms** the design's Svelte clue: the metadata is
    `__svelte_meta.loc` with a `file` field. The code reads only `file`, so it does not confirm `line` and
    `column` (the design says the meta has line and column; still to verify).
  - The probes run in the page's own JS world through `chrome.scripting.executeScript({world:"MAIN"})`
    from the background worker, which marks results as `data-handle-component` attributes that the content
    script (isolated world) then reads (`background.ts:98-202, 204-310`; `handle.content.ts:137-139`). Cost:
    it writes attributes onto the page DOM, and a full-tree pass annotates up to 3000 elements
    (`background.ts:286-294`). Tweak's design (read in the page's own world and return data) avoids writing
    attributes; a `postMessage` or a dispatched `CustomEvent` from an injected MAIN-world script is the
    alternative.
  - Framework hydration: if the tree has no components, retries every 200 ms up to 10 times for framework
    markers (`handle.content.ts:211-229`; `dom.ts:251-275` scans the first 200 body elements).
- **Styles**: a fixed list of about 45 computed properties (font, colour, padding/margin per side, border,
  radius per corner, flex/grid properties only when relevant, size, min/max, overflow, shadow, line height,
  letter spacing, alignment) plus `textContent` for text-only elements (`handle.content.ts:232-330`).
  `getSpecifiedStyle` tries to recover the authored value of width/height by scanning every readable
  stylesheet for the **last** matching rule, ignoring specificity and `!important` (`:49-69`). It silently
  skips cross-origin sheets. It records no rule source locations; the design's "matching CSS rules with source
  locations" goes well beyond this.
- **Not captured**: HTML, accessibility role/name, test IDs, nearby text, viewport, screenshot, source
  file/line, source maps (grep for `outerHTML`, `captureVisibleTab`, `__file`, `sourceMappingURL` over
  `ext shared mcp` returned nothing; `innerHTML` is only used to write swapped icons,
  `handle.content.ts:768-777`).

**What reaches the agent.** The side panel applies edits live to the page (`style[prop] = value`,
`textContent`, icon `innerHTML`; `handle.content.ts:757-788`) and records `{selector, component, props:
{original,current}, note}` per element (`useEditTracker.ts:77-123`). On send it formats plain text
(`useEditTracker.ts:132-177`), prefixed with the tab URL (`SidePanel.tsx:526-535`):

```
The following feedback is in reference to <url>

In <ComponentName>:
  - On <selector>: change padding from "8px" to "16px"
  - On <selector>: note "make this bolder"
```

Elements without a component fall under "unowned elements". Token-named values become `var(--name)`
(`useEditTracker.ts:145-147`). That is the whole brief: no file, no markup, no image, no ids that can be
replied to. The agent must find the code from a selector and component name alone.

## 4. How feedback reaches Claude Code, and what comes back

1. Handle's MCP process is spawned by Claude Code on stdio from `~/.claude.json` (`agents.ts:9-12, 486-496`).
2. The user types `/handle`; the command file tells Claude to call `get_design_feedback` with `agent_name`,
   `repo` and optional `context` and to tell the user to go to Chrome (`agents.ts:32-41`).
3. The tool call **blocks** until feedback arrives: it creates `sessionState`, opens Chrome with `open -a
   "Google Chrome"` (`server.ts:234-246, 314-316`), emits `collect_feedback` to connected sockets and awaits a
   promise (`server.ts:371-411`). It sends an MCP progress notification every 5 s to keep the call alive
   (`server.ts:40, 356-369`).
4. The side panel polls `http://localhost:58932/api/sessions` every 3 s (`SidePanel.tsx:27, 738-761`),
   auto-selects when exactly one session exists (`:763-778`) or shows a picker (`SendBar.tsx:107-125`), and
   connects Socket.IO with `auth: {sessionId}` (`SidePanel.tsx:791-793`; server check `server.ts:99-107`).
5. On Send the panel either answers the pending `collect_feedback` ack or emits `design_feedback`
   (`SidePanel.tsx:537-542`; `server.ts:120-122, 381-383`). The tool call returns
   `<handle-feedback session_id="...">...</handle-feedback>` plus an instruction to call the tool again
   immediately (`server.ts:248-256`). Claude implements, then re-calls, which re-arms the wait. Stop is a
   button that emits `stop_session` and the next return is `<handle-exit reason=.../>` (`server.ts:124-126,
   258-270`).
6. **Back-channel**: only `session_ended` with a reason (`server.ts:90`) and, when the agent re-calls, the
   `collect_feedback` event, on which the panel just rebuilds the element tree so the agent's DOM changes show
   (`SidePanel.tsx:801-816`). There is **no** status, plan, question, reply or result. The panel cannot tell
   "Claude is working" from "Claude is not listening". "Working" is inferred by the absence of an active
   `collect_feedback` callback **(inference)**.
7. Mechanics worth noting: queue while no call is in flight (`server.ts:72-81`); 8 s grace period for the
   extension to reconnect before the session is declared over (`server.ts:41-43, 128-141`); stale session
   files cleaned by a `process.kill(pid, 0)` liveness check (`server.ts:174-202`).

## 5. Comparison with the Tweak design

| Topic | Handle | Tweak design | Reading |
|---|---|---|---|
| Delivery | blocking MCP tool in a prompt loop; between calls nothing listens | Monitor events start a turn in an idle session | Design is stronger. In Handle, feedback typed while Claude is mid-edit is queued (`server.ts:72-81`) but only delivered if Claude loops back; if Claude stops looping the session silently stalls. |
| Session choice | user picks from a list, or auto when one | URL-pattern claims, overlap refused, lapse after ~60 s | Design is stronger. Handle has no concept of "this page belongs to that session"; two projects open means a manual dropdown (`SendBar.tsx:107-125`). |
| Discovery | fixed port 58932 + `~/.handle/sessions` files | one bridge, SQLite | Fixed-port discovery race is handled by "first process wins" (`server.ts:223-232`): if the owning process dies, other sessions are not listed until restart **(inference)**. |
| Acknowledgement | none (fire into a socket; ack only when a call is pending) | confirmed events, redelivered on reconnect | Design is stronger. |
| Status/replies | none | Sent/Queued/Working/Question/Done/Declined, live card | Handle gives nothing to borrow. |
| Undo | per-property undo in the editor (`StyleEditor.tsx:1377`) of the browser-side preview only; nothing to revert agent edits | patch store + PreToolUse hook | No overlap. |
| Pins | none; selection lives in the side panel hierarchy tree | pins at click point, re-attach by selector | No overlap, though Handle's `elementCache` keyed by selector path for re-selection (`handle.content.ts:44-46, 789-795`) is the same idea. |
| Mappers | component name from React/Vue/Angular/Svelte globals | exact source locations from React `_debugSource/_debugStack`, Vue `__file`, Svelte meta, Rails comments | Handle supplies the probe entry points; the design needs more fields from each. For Vue, Handle confirms the `__vueParentComponent` entry point but reads `type.name/__name`, so `type.__file` stays unverified. |
| Brief | text diff + selector + URL | request, elements, source, styles, HTML, screenshot | Design is far richer. |
| UI surface | Chrome side panel is the primary UI | in-page overlay, pins, card; side panel secondary | Handle's use of the side panel API is worth learning from for Tweak's side panel (open per tab, close port). |
| Edits | live-mutates the page (set style/text) and sends the diff | page left untouched; Claude edits code | Different model; no overlap. |

## 6. UX worth borrowing

- Measurement overlay on hover (padding, margin, gap shaded in distinct colours, labelled px values),
  `dom.ts:278-402`. Useful for "make this padding bigger" tweaks; also a cheap way to show what the user is
  about to point at. Optional for v1.
- Delayed single-click versus double-click to distinguish "select" from "edit text"
  (`handle.content.ts:414-424`). Tweak's design uses ⌥-click and selection, so the problem differs; keep as
  reference if an inline "edit text here" gesture is ever added.
- Selection that survives SPA navigation: `history.pushState/replaceState` wrappers plus `popstate`, calling a
  clear-and-rebuild (`handle.content.ts:668-692`). Needed for Tweak's pins on SPAs. Caveat: wrapping
  `history` methods from an isolated-world content script only affects that world's `history` object in some
  cases. In MV3 isolated worlds `window.history` methods are separate wrappers of the page's, so page calls
  to `pushState` are not intercepted **(inference, not tested; verify)**. The `navigate` event
  (`navigation.addEventListener("navigate")`) is the reliable alternative in Chromium.
- Retry-until-hydrated for framework metadata (`handle.content.ts:211-229`); Tweak's mappers will hit the
  same early-click timing issue.
- Side panel lifecycle: a port named `sidepanel:<tabId>` to detect close, and re-arming after reload
  (`background.ts:75-96`).
- Re-injecting the content script into tabs open before install (`background.ts:52-65`); Tweak's runtime
  script registration will need the same for tabs already open when a claim starts.
- Copy fallback: with no session connected, the panel can still copy the formatted feedback to the clipboard
  (`SidePanel.tsx:495-509`, with an `execCommand` fallback at `:33-45`). Cheap to mirror: "copy brief" for when no
  session claims the page.
- Install hint as a hover popover with a copy button (`SendBar.tsx:15-60`), and a visible "no session found"
  state in the send bar (`SendBar.tsx:84-90`). Matches Tweak's "no session claims this page" side-panel text.
- Dark mode and Tailwind styling across the side panel (`SendBar.tsx` classes use `dark:`). Tweak has no
  framework so only the idea carries.

## 7. Weaknesses to avoid

1. **Any web page can probably talk to the agent.** Fact from the code: both servers call `listen()` with no host
   (`server.ts:145` `httpServer.listen(0, ...)`, `server.ts:224` `.listen(DISCOVERY_PORT, ...)`), and Node's default for
   that is all interfaces, not loopback, so other machines on the network can reach them **(inference on the Node
   default; not run)**. Also `server.ts:68-70` sets Socket.IO `cors: {origin: "*"}`
   and `server.ts:208-211` serves the session list (id, port, repo, agent name, context) with
   `Access-Control-Allow-Origin: *` and no auth. The only socket credential is the session id
   (`server.ts:99-107`), which that endpoint hands out. So a hostile page can **(inference, not tested; Chrome
   Private Network Access may block some requests)** read the id and port and emit `design_feedback`
   (`server.ts:120-122`), which is returned to Claude as a trusted "feedback to implement" result
   (`server.ts:248-256`). That is prompt injection into a coding agent with file and shell access. Tweak's
   `x-tweak` header, Origin refusal and Host check (design "Security") address exactly this; keep them and test
   them against a hostile page and a DNS-rebinding setup.
2. **Page-sourced text goes in as instructions.** `useEditTracker.ts:168-172` embeds the page's original
   values (including text content) directly into the line Claude reads, unmarked. Tweak's "data, not
   instructions" rule is right.
3. **Always-on, all-sites footprint.** `<all_urls>` content script plus `https://*/*` host permission
   (`handle.content.ts:13`, `ext/wxt.config.ts:8`), and it installs wrappers on `history` and registers listeners
   on every page it loads in. Tweak's claim-gated injection is the better design. Also the extension opens a
   tab to `gethandle.ai` on install **and every update** (`background.ts:39-44`) and ships Statsig analytics
   (`ext/lib/statsig.ts`) and a review nag (`ext/lib/reviewPrompt.ts`): not for a local dev tool.
4. **No acknowledgement and no state.** The extension cannot show whether Claude received or finished a
   request (see 4.6). The prompt-loop design also depends on the model obeying "call get_design_feedback
   again immediately" (`server.ts:254`); if it ends the turn instead, the session stalls without notice.
5. **Fragile selector path** (see 3). Unescaped class names, no uniqueness guarantee, and no attempt at
   `data-testid` or text anchors. Tweak's search-clue list is the right direction.
6. **Page mutation by the inspector**: `data-handle-target` and `data-handle-component` attributes written to
   the page during probing and cleaned up later (`background.ts:115-117`, `handle.content.ts:729-731`),
   inline `outline` on hover. A crash between write and cleanup leaves residue. Tweak's design principle
   ("overlay never runs application code") is cleaner.
7. **Triplicated logic**: `detectComponent` exists three times (`dom.ts:176`, `background.ts:119`,
   `background.ts:217`) and again as a string snippet (`dom.ts:532`). Tweak's mapper interface should have
   one definition injected into the MAIN world.
8. **Bounded but lossy tree walk**: 3000 nodes, 50 children (`dom.ts:10-12`); large pages silently lose
   subtrees.
9. **`getSpecifiedStyle`** ignores specificity and cross-origin stylesheets (`handle.content.ts:49-69`);
   Tweak's matching-rules-with-source needs `CSSOM` plus source maps and must report "unreadable sheet".
10. **Docs inconsistency**: `mcp/README.md:56` points to `github.com/anthropics/handle`, while the repo is
    `tonkotsu-ai/handle`; the MCP package is `handle-ext` while the extension and brand are "Handle". Minor,
    but a sign to check provenance on anything copied.
11. **Single squashed commit** (see top): no way to audit history, and the project is young (version
    `1.0.x`, `mcp/package.json:3`). Expect it to change under any code that tracks it; copy, do not depend.

## 8. Ranked: what to reuse or learn from

Reuse with credit (port to plain JS; add the notice):
1. **Framework probe order and shapes** (`shared/src/utils/dom.ts:176-249`): React fiber key prefixes
   `__reactFiber$`/`__reactInternalInstance$`, Vue 3 `__vueParentComponent` (with the root-element-only
   rule), Vue 2 `__vue__`, Angular `ng.getComponent`, Svelte `__svelte_meta.loc.file` with the "outermost
   element of the file only" rule. Extend, not copy: add `_debugSource`/`_debugStack`, `type.__file`, and
   line/column.
2. **Capture-phase click swallowing on `window`** with `elementsFromPoint` hit test that skips overlay and
   invisible elements (`handle.content.ts:405-406, 695-702`; `dom.ts:147-170`).
3. **Measurement overlay** (`dom.ts:278-402`), if Tweak wants it in the overlay (optional).
4. **Framework-hydration retry** (`handle.content.ts:211-229`; `dom.ts:251-275`).
5. **Content-script re-injection for already-open tabs** (`background.ts:52-65`).

Learn from (ideas, no code):
6. **Side-panel lifecycle**: per-tab enable plus `sidepanel:<tabId>` port to detect close (`background.ts:23-37,
   75-96`).
7. **Session liveness by pid** and reconnect grace period (`server.ts:41-43, 174-202`), analogous to Tweak's
   60 s claim lapse; their 8 s grace is the reason a reload does not end a session.
8. **SPA navigation detection** (`handle.content.ts:668-692`): reuse the idea, verify the isolated-world
   caveat, prefer the Navigation API.
9. **Anti-patterns above**, especially #1 (CORS `*` discovery) as a test case for Tweak's bridge security
   tests: a contract test that a web `Origin` is refused is directly worth writing.

Not worth reusing: the MCP server, the Socket.IO transport, the `init` installer for eight agents, the
StyleEditor/ColorPicker/IconPicker (a different product), analytics, review prompt.
