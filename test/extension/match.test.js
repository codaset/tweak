// The extension's match-pattern check, for dormancy. The cases are Chrome
// 158's behaviour as probed in ticket 26, shared with internal/pattern's Go
// test: both implementations must agree on every one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matches } from "../../extension/lib/match.js";

const cases = JSON.parse(readFileSync(new URL("../fixtures/match-cases.json", import.meta.url), "utf8"));

for (const { pattern, url, want } of cases) {
  test(`${pattern} ${want ? "matches" : "doesn't match"} ${url}`, () => {
    assert.equal(matches(pattern, url), want);
  });
}
