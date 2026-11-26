# Bridge contract schema

The source of truth for every message between the bridge, the CLI and the extension
(`docs/design.md`, "Bridge contract"). No code is generated from it.

- `<name>.json`: one JSON Schema (draft 2020-12) per message.
- `examples/<name>.<case>.json`: messages that must validate against `<name>.json`.
- `examples/invalid/<name>.<case>.json`: messages that must be refused by it.

Both sides test against the examples: Go in `schema/schema_test.go`, JavaScript in
`test/extension/schema.test.js`. Every schema needs at least one valid and one invalid example; both tests fail without them.
