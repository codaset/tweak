# Codaset Tweak

Point at any element on your dev server, describe a tweak, and the Claude Code session that claimed the page makes the change. The agreed design is in `docs/design.md`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on codaset/tweak, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
