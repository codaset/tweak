# End-to-end driver for the extension: Puppeteer, Playwright or plain CDP

Resolves [#19](https://github.com/codaset/tweak/issues/19). Builds on
[Chrome extension APIs](https://github.com/codaset/tweak/blob/research/chrome-extension-apis/docs/research/chrome-extension-apis.md) (#8) on branch `research/chrome-extension-apis`:
permission prompts need a real user gesture, and `captureVisibleTab` needs `activeTab` or the literal
`<all_urls>`. Not redone here.

## Evidence labels

- **experiment**: run by me on **macOS arm64** (not Ubuntu) with a throwaway MV3 extension, Puppeteer
  25.19.0 and Playwright 1.65.1, against Chrome for Testing 158.0.8127.88 (Stable on 2026-11-25), and
  Playwright's bundled Chromium 159.0.8154.x. Scripts lived in the session scratchpad, not the repo.
- **source**: read in docs or source code (linked inline).
- **unverified**: not checked either way.

CI runs on Ubuntu. Every experiment result below holds on macOS; the same Chrome code drives
headless on Linux, but no Ubuntu run was made.

## Answer in short

Use **Puppeteer (25.x) with `enableExtensions` and Chrome for Testing in new headless**. It drove every
item on the list except the permission dialog itself, which nothing can drive headlessly. Playwright
also drove everything except the toolbar-action click. Plain CDP is not worth it.

## Findings

### 1. New headless supports extensions, the side panel and `--load-extension`

- `--headless=new` (Puppeteer's `headless: true`) loads unpacked MV3 extensions in Chrome for Testing.
  Old headless was removed from the `chrome` binary in 132; `--headless` now means new. (source:
  [Chrome blog](https://developer.chrome.com/blog/removing-headless-old-from-chrome),
  [extension testing docs](https://developer.chrome.com/docs/extensions/how-to/test/end-to-end-testing):
  old headless "does not support loading extensions")
- `chrome-headless-shell` (Puppeteer `headless: 'shell'`, Playwright's default headless) does not load
  extensions. Playwright with the default bundled headless shell never produced a service worker in
  5 s. (experiment)
- `--disable-extensions-except=DIR --load-extension=DIR` still works in Chrome for Testing 158 headless,
  through Puppeteer and Playwright. The branded-Chrome removal does not apply. (experiment; Playwright's
  [docs](https://playwright.dev/docs/chrome-extensions) say the same: use bundled Chromium, not branded
  Chrome or Edge)
- Puppeteer 25 adds a first-class path: `puppeteer.launch({ enableExtensions: [dir] })`, which loads
  the extension through the CDP `Extensions` domain over a pipe and omits `--disable-extensions`.
  `browser.installExtension()`, `browser.extensions()`, `page.triggerExtensionAction()` and
  `page.extensionRealms()` come with it. (source:
  [Puppeteer extensions guide](https://github.com/puppeteer/puppeteer/blob/main/docs/guides/chrome-extensions.md);
  experiment: all worked)
- Wrinkle: `browser.extensions()` returned an empty map right after launch with `enableExtensions`. Call
  it again after the service worker target appears, or take the id from the worker URL. (experiment)

### 2. ⌥-click, isolated-world content script, top-layer popover: works

- Puppeteer: `page.keyboard.down('Alt'); page.click('#el'); page.keyboard.up('Alt')`. Playwright:
  `locator.click({ modifiers: ['Alt'] })`. Both reach a content script's capture-phase `click` listener
  with `e.altKey === true`. (experiment)
- The content script (isolated world) created a `popover="manual"` element and called `showPopover()`.
  `:popover-open` matched and `document.elementFromPoint` over it returned the popover, so the top layer
  is real in headless. The page's own `window.pageGlobal` was `undefined` to the content script,
  confirming world isolation. (experiment)
- To evaluate inside the content script's world: `page.extensionRealms()` returned the realm and
  `realm.evaluate(() => chrome.runtime.id)` worked. (experiment) Playwright has no equivalent; it would
  need raw CDP isolated-world contexts. (unverified)

### 3. Side panel: a real, readable page target in headless

- `chrome.sidePanel.open({ tabId })` succeeded when called from a content-script click relayed to the
  worker. After it, a `page` target with the panel URL appeared in `browser.targets()`. Puppeteer
  `target.asPage()` read its DOM and clicked inside it. (experiment)
- Without a gesture, `sidePanel.open()` throws "may only be called in response to a user gesture" in
  headless as well. CDP-synthesised mouse input (`Input.dispatchMouseEvent`, what `page.click` sends)
  counts as a gesture. (experiment; source:
  [`side_panel_api.cc`](https://github.com/chromium/chromium/blob/main/chrome/browser/extensions/api/side_panel/side_panel_api.cc),
  line 75, `if (!user_gesture())`)
- Not driveable: the toolbar context menu entry and the ⌥⇧N shortcut. A manifest `commands` entry with
  `suggested_key` ⌥⇧N registered (`chrome.commands.getAll()` showed it) but `Alt+Shift+N` typed through
  the CDP keyboard never fired `onCommand`; accelerators belong to the browser UI, not the page.
  (experiment) Tests should call the same handler another way: a test-only message, or an action click
  (item 6).
- Fallback that always works: open `chrome-extension://<id>/panel.html` as a normal tab and drive it.
  It lacks the real side-panel sizing and lifecycle but runs the same code. (experiment)

### 4. Service worker: reach, stop and restart both work

- Puppeteer: `browser.waitForTarget(t => t.type() === 'service_worker')`, then `target.worker()` and
  `worker.evaluate(...)` gives `chrome.*` access. Playwright: `context.serviceWorkers()` or
  `waitForEvent('serviceworker')`, then `sw.evaluate`. (experiment; Puppeteer guide covers this too)
- Stop: open a CDP session on an extension page (or any page), `ServiceWorker.enable`, collect
  `workerVersionUpdated`, then `ServiceWorker.stopWorker({ versionId })`. Status went `stopping`,
  `stopped`, the service worker target count went to 0, and the next `runtime.sendMessage` from the
  extension page woke a fresh worker (`self.startedAt` changed). Same in Playwright via
  `context.newCDPSession(page)`. (experiment)
- The browser-level session does not have the `ServiceWorker` domain ("wasn't found"); use a page-level
  session. Worker handles are stale after a restart: re-fetch with `waitForTarget`. (experiment)
- Puppeteer's guide also mentions "forcefully terminating the service worker". (source)

### 5. Optional `<all_urls>`: cannot be granted through the prompt, so pre-grant in the test manifest

- A real click in an extension page calls `permissions.request({ origins: ['<all_urls>'] })` with a
  genuine gesture. Headless shows no usable dialog: the promise never settled in 2 s and the grant
  stayed false. (experiment; extends #8's finding that the dialog could not be seen)
- The Chromium source has no switch that auto-confirms. The only auto-accept routes are test hooks in C++
  (`SetDialogActionForTests`) and permission sets with no warnings, which `<all_urls>` is not.
  (source: [`permissions_api.cc`](https://github.com/chromium/chromium/blob/main/extensions/browser/api/permissions/permissions_api.cc),
  around lines 403 to 470)
- Pre-grant by changing the manifest the test loads: copy `extension/` to a temp dir and move
  `<all_urls>` from `optional_host_permissions` to `host_permissions`. An unpacked extension loaded on
  the command line gets its manifest permissions granted. With that copy, `permissions.contains` was true
  and `permissions.request` resolved `true` at once ("all permissions already active", source line
  about 397). `captureVisibleTab` worked on any origin. (experiment)
- So the tests cover everything after the grant, and the grant itself (the claim to "Allow" button to
  dialog path) is a manual check, or a unit test that stubs `chrome.permissions`.
- Profile reuse is a second possible route (grants persist in the profile prefs, which the code reads:
  `GetRuntimeGrantedPermissions`), but seeding it without the dialog is not possible except by editing
  Secure Preferences. (unverified, not recommended)

### 6. `captureVisibleTab` works in headless

- With `<all_urls>` pre-granted: PNG data returned for 127.0.0.1 and for example.com. (experiment)
- With only `activeTab` and no host permission: refused until the action is triggered on that tab.
  Puppeteer 25 `page.triggerExtensionAction(extension)` (CDP `Extensions.triggerAction`) fired
  `chrome.action.onClicked`, granted `activeTab`, and `captureVisibleTab` then succeeded on the
  `localhost` page. A same-origin navigation kept it. (experiment) This lets a test follow the real
  `activeTab` path the design may rely on without a toolbar.
- Rate limit: two calls in quick succession hit `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`. Space calls
  out (sleep over 1 s) or the test flakes. (experiment)
- Playwright: `Extensions.triggerAction` requires a `tab` target id, and Playwright's CDP session
  hides tab targets (`Target.getTargets` listed only `page`, `service_worker`, `browser_ui`), so the
  call failed with "Invalid parameters". A workaround may exist; not found. (experiment)

### 7. Pinning Chrome for Testing

- Puppeteer: `npx @puppeteer/browsers install chrome@158.0.8127.88`, or set the `chrome.version` option in
  `.puppeteerrc.cjs`, and cache `PUPPETEER_CACHE_DIR` in `actions/cache` keyed on the version.
  Each Puppeteer release also bundles a default Chrome (25.19.0 resolved to 158.0.8127.88, the Stable on
  the day of the experiment). (source: [`@puppeteer/browsers` README](https://github.com/puppeteer/puppeteer/blob/main/packages/browsers/README.md),
  [configuration guide](https://github.com/puppeteer/puppeteer/blob/main/docs/guides/configuration.md);
  experiment: the install worked)
- Chrome for Testing publishes exact builds and a `last-known-good-versions.json` feed. The linux64
  `chrome-linux64.zip` for 158.0.8127.88 exists (HTTP 200 checked). (source/experiment:
  [feed](https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json),
  [Chrome blog](https://developer.chrome.com/blog/chrome-for-testing))
- Playwright pins the browser to the Playwright version (1.65.1 bundles Chromium 159, build 1257 in
  `browsers.json`), so bumping Chrome means bumping Playwright; `executablePath` can point it at a
  Chrome for Testing build instead (experiment: CfT 158 worked through Playwright).

### 8. Run time per fixture

macOS arm64, local, warm (experiment):

- Puppeteer, CfT: launch plus extension load plus service worker ready 0.3 to 0.5 s. A whole scenario
  (navigate, ⌥-click, popover check, side panel, capture, worker stop and restart) about 2 to 6 s, of
  which 1.5 to 2.5 s are my deliberate waits.
- Playwright, CfT: launch 0.6 s, scenario about 3.5 s. Playwright's bundled channel: launch 1.8 s,
  scenario about 4.8 s.
- Not measured: Ubuntu, a cold browser download (about 14 s for CfT on this connection, 150 MB class), and
  the fixture dev servers (Rails, Vite, SvelteKit boot), which will dominate. One browser per fixture or
  one per job are both cheap; budget a few seconds per scenario for the driver. (Ubuntu: unverified)

### 9. Ubuntu in GitHub Actions: known issues, not run

- Chrome needs shared libraries on a bare runner; `npx puppeteer browsers install` does not install
  them, `playwright install --with-deps` does. (unverified; runner images ship most)
- Ubuntu 23.10 and later restrict unprivileged user namespaces through AppArmor, which breaks Chrome's
  sandbox; Puppeteer documents `--no-sandbox` as the workaround, or the AppArmor profile or sysctl change
  at the linked Chromium doc. A CfT binary in a cache folder is not covered by the profile for installed
  Chrome, but whether ubuntu-24.04 runners block it was not checked. Plan for `--no-sandbox` in CI only.
  (source: [Puppeteer troubleshooting](https://github.com/puppeteer/puppeteer/blob/main/docs/troubleshooting.md),
  "Issues with AppArmor on Ubuntu"; unverified on a runner)
- New headless needs no Xvfb. (source: Chrome docs above)

## Comparison

| Need | Puppeteer 25 | Playwright 1.65 | Plain CDP |
| --- | --- | --- | --- |
| Load unpacked MV3 into CfT headless | `enableExtensions`, or flags | flags, persistent context, `channel: 'chromium'` or CfT `executablePath` | flags plus own launcher |
| ⌥-click | yes | yes | `Input.dispatchMouseEvent` with modifiers |
| Content-script realm eval | `page.extensionRealms()` | not found | `Runtime` contexts by hand |
| Side panel read and click | page target | page target | same |
| Service worker reach | yes | yes | yes |
| Stop and restart worker | yes (page CDP session) | yes (page CDP session) | yes |
| Action click (`activeTab`) | `page.triggerExtensionAction` | failed (tab targets hidden) | `Extensions.triggerAction`, needs a tab target id |
| Permission dialog | no | no | no |
| Test runner, retries, traces | bring your own (node:test, Vitest) | built in | none |

## Recommendation

Puppeteer 25 with `enableExtensions` and a pinned Chrome for Testing, run from the repo's own test
runner (for example `node --test`, or Vitest). Reasons: first-class extension loading, `triggerExtensionAction`
for the `activeTab` path, `extensionRealms()` for content-script checks, and no browser-version
coupling to the driver version. Playwright is a fair second choice if its test runner and trace viewer
are wanted; it loses only `triggerExtensionAction`.

## Conflicts with design.md

- The ticket cites "design.md § CI". This branch's `docs/design.md` has no CI section (headings stop at
  Testing, Before building, Not in v1) and no mention of Chrome 137. § Testing says only "end-to-end in
  headless Chrome against fixture apps". The CI facts in this note should go into design.md.
- § Testing needs to say: Chrome for Testing, pinned, new headless; the optional `<all_urls>` grant and
  the real shortcut or toolbar menu are not covered end to end, with the grant tested through a
  `host_permissions` copy of the manifest.

## Not verified

- Anything on Ubuntu or a GitHub-hosted runner (sandbox, libraries, timings).
- The permission dialog itself, the toolbar context menu, the real ⌥⇧N shortcut.
- A Playwright path to `Extensions.triggerAction`, and content-script realm evaluation in Playwright.
- Runtime `scripting.registerContentScripts` under these drivers (covered by #8, not repeated).
