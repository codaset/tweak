// The extension's match-pattern check, for dormancy. The cases are Chrome
// 158's behaviour as probed in ticket 26 (internal/pattern has the same).
import { test } from "node:test";
import assert from "node:assert/strict";
import { matches } from "../../extension/lib/match.js";

const cases = [
  ["https://ernie.localhost/*", "https://ernie.localhost/admin?tab=2#x", true],
  ["https://ernie.localhost/*", "http://ernie.localhost/", false],
  ["*://ernie.localhost/*", "http://ernie.localhost/", true],
  ["*://ernie.localhost/*", "ftp://ernie.localhost/", false],
  ["http://localhost/*", "http://localhost:3000/", true], // no port: every port
  ["http://localhost:3000/*", "http://localhost:3001/", false],
  ["http://localhost:80/*", "http://localhost/", true], // the effective port
  ["https://*.bert.localhost/*", "https://bert.localhost/", true],
  ["https://*.bert.localhost/*", "https://a.b.bert.localhost/x", true],
  ["https://*.bert.localhost/*", "https://notbert.localhost/", false],
  ["http://*/*", "http://anything.test/", true],
  ["https://ernie.localhost/admin/*", "https://ernie.localhost/admin/users", true],
  ["https://ernie.localhost/admin/*", "https://ernie.localhost/other", false],
  ["https://e.localhost/qq*a=1*", "https://e.localhost/qq?a=1", true], // the glob sees the query
  ["https://e.localhost/hh*b*", "https://e.localhost/hh#b", false], // never the hash
  ["https://e.localhost/*", "not a url", false],
];

for (const [pattern, url, want] of cases) {
  test(`${pattern} ${want ? "matches" : "doesn't match"} ${url}`, () => {
    assert.equal(matches(pattern, url), want);
  });
}
