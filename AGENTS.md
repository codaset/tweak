# Codaset Tweak

Point at any element on your dev server, describe a tweak, and the Claude Code session that claimed the page makes the change. The agreed design is in `docs/design.md`.

## Working on the code

- Go: `go test -race ./...`, `go vet ./...`, `gofmt -l .` (CI fails on any output).
- JavaScript: `npm ci`, then `npm test` (`node --test`; `ajv` and `puppeteer` are the only dev dependencies).
- End to end: `npm run e2e` (needs Go; Chrome for Testing comes from `npx puppeteer browsers install chrome`, pinned in `.puppeteerrc.cjs`). It builds the binary, then runs `test/e2e/<fixture>.test.js` in headless Chrome against `fixtures/<fixture>/`, a development bridge on a random port with a temporary state folder, and a scripted stand-in for Claude. Run it before every push, like the other checks.
  - A new case: add it to the fixture's `expected.json` (design.md § Golden data); the fixture's test file runs every case through `tracer()` in `test/e2e/harness/index.js`.
  - A new fixture: `fixtures/<name>/` with `fixture.json` (`start`, an argv with `{port}` that binds `127.0.0.1`; `ready`, a path; `public`, the folder its server serves at the root, where the runner writes its readiness marker; optional `needs`, toolchain commands; optional `loaded`, a selector a page waits for, e.g. hydration), `expected.json`, a lockfile, a `test/e2e/<name>.test.js` copied from `static.test.js`, and a grouped entry in `.github/dependabot.yml`. `npm test` checks each is there. A fixture with npm dependencies (the Vite ones) needs `npm ci --prefix fixtures/<name>` before `npm run e2e`, locally and as a step in CI's `e2e` job.
  - Reloads: `setup()` turns the app's auto-reload off, so a Done reloads nothing under a test. `tracer()` turns it on for a case with an `edit` (a round trip), and `autoReload(env, on)` does it for any other test that needs it.
  - Time-driven cases: `setup(fixture, { againAfter: "1s" })` gives its describe its own bridge, which sends an unconfirmed tweak again after 1 s instead of 3 minutes (the test-only `TWEAK_TEST_AGAIN_AFTER`, a Go duration, read only by a development build). `lapseAfter` (`TWEAK_TEST_LAPSE_AFTER`, instead of the 10-minute claim lapse) and `unwatchedAfter` (`TWEAK_TEST_UNWATCHED_AFTER`, instead of the minute before `no watcher running`) work the same way, and so does `keepResolved` (`TWEAK_TEST_KEEP_RESOLVED`, instead of the 7 days a resolved tweak is kept). Go tests drive time through `bridge.Options.Clock` instead.
  - The overlay is in a closed shadow root: reach it with `contentScript(page)` (`test/e2e/harness/browser.js`), which evaluates in the content script's world. The test copy of the extension (`harness/extension.js`) patches the bridge port and pre-grants `http://localhost/*`.
- Versions: `npm run check:consistency`. The plugin, extension and launcher share one `X.Y.Z`; only the release workflow changes it.
- Plugin: `claude plugin validate plugins/codaset` and `claude plugin validate .`; load it in place with `claude --plugin-dir plugins/codaset`.
- Run a local build through the launcher with `TWEAK_BIN=<path to the build>` (`make build` writes `dist/tweak`).
- `make install` is the developer's own Tweak, on the live port and state folder (README § Trying your changes). Never run it from a task or a test: it stops the live bridge.
- The bridge contract lives in `schema/`: add a schema, a valid example and the invalid cases together (see `schema/README.md`).
- Never test against the live bridge or its sessions.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on codaset/tweak, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
