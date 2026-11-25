# Codaset Tweak

Point at any element on your dev server, describe a tweak, and the Claude Code session that claimed the page makes the change. The agreed design is in `docs/design.md`.

## Working on the code

- Go: `go test -race ./...`, `go vet ./...`, `gofmt -l .` (CI fails on any output).
- JavaScript: `npm ci`, then `npm test` (`node --test`; `ajv` is the only dev dependency so far).
- Versions: `npm run check:consistency`. The plugin, extension and launcher share one `X.Y.Z`; only the release workflow changes it.
- Plugin: `claude plugin validate plugins/codaset` and `claude plugin validate .`; load it in place with `claude --plugin-dir plugins/codaset`.
- Run a local build through the launcher with `TWEAK_BIN=<path to the build>`.
- The bridge contract lives in `schema/`: add a schema, a valid example and the invalid cases together (see `schema/README.md`).
- Never test against the live bridge or its sessions.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on codaset/tweak, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
