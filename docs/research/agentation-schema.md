# Agentation's annotation schema (AFS v1.1) and Codaset Tweak

Researched 2026-11-26 against https://www.agentation.com/schema, https://agentation.com/schema/annotation.v1.1.json, https://agentation.com/mcp, https://github.com/benjitaylor/agentation, https://registry.npmjs.org/agentation, and this repo (`schema/`, `docs/design.md`, `GLOSSARY.md`, `extension/`).

Legend: **[V]** verified first-hand (fetched or read it); **[D]** stated in the official docs, not run by me; **[I]** inferred.

## Answer

- **Verdict: not useful enough to adopt, align with, or export to now. Ignore it, and revisit only if a user asks for Agentation interop.** Nothing in it fills a gap Tweak has chosen to fill. [I, from the comparison below]
- **What it is:** an annotation object ("Annotation Format Schema", AFS v1.1) for human feedback on UI elements, shipped with a React toolbar (`agentation` on npm, 3.1.2) and an MCP server (`agentation-mcp`) that lets agents list, acknowledge, resolve, dismiss and reply to annotations. [D: https://www.agentation.com/schema, https://agentation.com/mcp; V: https://registry.npmjs.org/agentation]
- **It is one vendor's format, not a standard.** Maintainers are Benji Taylor, Dennis Jin and Alex Vanderzon; the schema page claims tools "can emit annotations in this format" but names no adopter other than Agentation's own packages. [D: schema page; V: the GitHub README names none]
- **Licence is a real obstacle to copying.** The repo is PolyForm Shield 1.0.0: no use "to provide a product or service that competes with the Software". Tweak is arguably an Agentation competitor (point at an element, tell a coding agent). The schema page states no licence of its own. Implementing the JSON shape is probably fine (field names are facts), but copying their code or text is not; legal call, not mine. [V: https://raw.githubusercontent.com/benjitaylor/agentation/main/LICENSE; I for "competitor"]
- **The format is weaker than Tweak's own on the parts that matter to Tweak.** It has a single `sourceFile` string and a `reactComponents` string; Tweak has structured locations (file, line, column, role, mapper, name), search clues, matching CSS rules with source-mapped lines, multi-element, text-selection and area targets. [V: `schema/create.json`; D: schema page]
- **The published JSON Schema is thinner than the page.** `annotation.v1.1.json` defines 20 properties; the page's AFS v1.1 table also lists `cssClasses`, `sourceFile`, `attributes`, `computedStyles`, `accessibility`, `nearbyText`, `selectedText`, `frame`, `resolvedAt`, `resolvedBy`, `thread`. A validator would accept them only because `additionalProperties` is unset. So the machine-readable contract and the prose disagree. [V: fetched the JSON and counted its `properties`]
- **Only two ideas are worth a note, and both are already decided.** `intent` (fix/change/question/approve) and `severity` (blocking/important/suggestion) are in design.md's "Not in v1". Revisit them on their own merits, not to match Agentation. [V: `docs/design.md` § Not in v1]

## Details

### 1. What Agentation publishes

- Page: "an open annotation format and toolset for UI feedback"; current version v1.1; JSON Schema link; GitHub `benjitaylor/agentation`; MCP at `/mcp`; npm "not listed on this page"; licence "not stated on this page". [V: https://www.agentation.com/schema]
- Required: `id`, `comment`, `elementPath`, `timestamp` (Unix ms), `x` (% of viewport width), `y` (px from document top, or viewport if `isFixed`), `element` (tag name). The JSON file agrees on these seven and the two `x`/`y` descriptions. [V: https://agentation.com/schema/annotation.v1.1.json]
- Recommended `url`, `boundingBox`. Optional context: `reactComponents`, `cssClasses`, `sourceFile`, `attributes`, `computedStyles`, `accessibility`, `nearbyText`, `selectedText`, `intent`, `severity`, `kind` (feedback/placement/rearrange) with `placement`/`rearrange` payloads, `isFixed`, `isMultiSelect`, `fullPath`, `nearbyElements`, `frame` (iframe path). Lifecycle: `status` (pending/acknowledged/resolved/dismissed), `resolvedAt`, `resolvedBy`, `thread` of `{id, role, content, timestamp}`. [D: schema page]
- Every context value is a flat string (`computedStyles`, `reactComponents`, `nearbyElements`, `accessibility` are strings, not structures). [D: schema page types]
- Repo: 5.5k stars, no GitHub releases, 388 commits, folders `mcp`, `package`, `skills`; README says the toolbar's copied output is Markdown and works with "Claude Code, Codex, Gemini, Grok, or any AI tool". [V: https://github.com/benjitaylor/agentation]
- npm `agentation` latest 3.1.2, modified 2026-09-22, PolyForm-Shield-1.0.0, maintainers dennisjin and benjitaylor. [V: https://registry.npmjs.org/agentation]
- MCP tools: `agentation_list_sessions`, `_get_session`, `_get_pending`, `_get_all_pending`, `_acknowledge`, `_resolve`, `_dismiss`, `_reply`, `_watch_annotations`. A local HTTP server (`POST /annotations`, port 4747 in the README) and the MCP server share one store; webhooks retry with `X-Agentation-Delivery-Id`. The package exports `AFSEvent`/`AFSEventType` types. [D: https://agentation.com/mcp, README]
- Not established: who besides Agentation emits or reads AFS; the schema's own licence; whether annotations persist across server restarts. I found no first-party statement on any of these.

### 2. Field by field against Tweak

| Agentation | Tweak (`schema/create.json` unless noted) | Note |
|---|---|---|
| `comment` | `request` | same idea; Tweak insists on non-blank text |
| `elementPath` / `fullPath` | `targets.elements[].selector` | both a CSS-style path; Tweak's must find the element again |
| `element` (tag) | `label` (tag plus distinguishing classes) | Tweak richer |
| `cssClasses`, `attributes` | `clues[]` (data-testid, id, aria-label, class...), `html` | Tweak ranks and caps clues |
| `reactComponents`, `sourceFile` | `locations[]` (file, line, column, role, via react/vue/svelte/rails/proscenium/css, name) | Tweak structured and multi-framework; the core of "Finding the source" |
| `computedStyles` (string) | `styles` (14 named properties, defaults omitted), `rules[]` (matching CSS rules with source-mapped file:line) | Tweak richer |
| `accessibility` | `role`, `name` | equivalent |
| `nearbyText`, `nearbyElements` | `nearby[]` (max 5) | equivalent |
| `selectedText` | `targets.selection` (text plus 40 chars either side) | Tweak richer |
| `boundingBox`, `x`, `y`, `isFixed` | `size`, `anchor` (0 to 1 fraction of element 1's box), `viewport`, `area` (page and viewport boxes) | different coordinate model: Agentation's pin is viewport-% and document-px, Tweak's is element-relative so it survives layout shifts |
| `isMultiSelect` | `targets.elements[]` numbered, plus `area` | Tweak richer |
| `url` | `url` | same |
| `frame` | none: top frame only, iframes not pickable | Agentation has it; design.md lists it "Not in v1" |
| `intent`, `severity` | none | "Not in v1" |
| `kind` placement/rearrange | none | out of scope: Tweak asks for a code change, not layout mock-ups |
| `status` pending/acknowledged/resolved/dismissed | `status` sent/delivered/queued/working/question/done/declined/withdrawn (`schema/status.json`) | Tweak's models a run with Claude; no 1:1 map |
| `thread` | conversation entries on a tweak, with Claude's questions and results | same idea; Tweak's carries edits and Undo |
| `timestamp`, `id` | tweak number, created/updated | Tweak's ids are small integers per bridge |

Sources: `schema/create.json`, `schema/status.json`, `docs/design.md` §§ Context per element, Finding the source, Pointing at things, Not in v1; Agentation side from the schema page. [V]

### 3. What Tweak does that Agentation does not model

- Claims: a session owns a URL pattern; tweaks route to it, lapse and restore (GLOSSARY.md, `schema/claim.json`). [V]
- A change record per tweak with Undo that checks for conflicts (`schema/undo.json`, `edit-before.json`; design.md § Undo). [V]
- Screenshots uploaded beside the tweak (`PUT /tweaks/:n/screenshot`; design.md § Screenshot). [V]
- Delivery guarantees: inbox, resends, "no lost tweaks" (design.md § No lost tweaks). [V]
- Treating every page string as data, never instructions (`create.json` descriptions). [V]

### 4. Would interop buy anything?

- **Consumers of AFS are Agentation's own.** The only agent-side reader I can show is `agentation-mcp`, and it reads annotations from its own store; it would not pick up Tweak's tweaks unless Tweak ran or called that server. [D for MCP; I for the consequence]
- **Tweak's agent side does not use MCP.** It delivers through the plugin, a `tweak` CLI, a Monitor watcher and event lines (design.md § Delivery to Claude, § Claude's side). An AFS export would feed nobody in that path. [V]
- **Export (Tweak to AFS) would be lossy and one-way.** Required `x`/`y` in viewport-% and document-px do not map from an element-relative anchor without extra capture; `elementPath` maps from `selector`; locations collapse into one `sourceFile` string. [I]
- **Import (AFS to Tweak) would give nothing to act on.** An imported annotation has no claim, no page in a Tweak session and no bridge status. [I]
- **Cost of the cheapest option** (a `tweak export --afs <n>` that writes the JSON): a mapper, a pinned copy of the schema, valid and invalid examples as `schema/README.md` requires, and a commitment to track a vendor's unversioned-in-practice format whose prose and JSON file already disagree. Benefit: none shown today. [I]

### 5. What to do

1. Do not adopt AFS as the bridge contract. It would drop structured locations, clues, rules and areas, which are the point of the product.
2. Do not add an export now. Record the decision here; reopen if someone needs Agentation's MCP or toolbar to see Tweak's output, and then build it as an export, not a schema change.
3. Treat `intent`/`severity` as a design question under "Not in v1", on their own evidence.
4. Do not copy Agentation's code or docs text (PolyForm Shield, competing-use clause).
