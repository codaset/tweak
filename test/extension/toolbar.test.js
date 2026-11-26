// What the toolbar button and ⌥⇧C do (design.md § Toolbar button): pick
// mode on a claimed page, the side panel on an unclaimed one or while the
// bridge is down.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolbar } from "../../extension/lib/toolbar.js";

const claimed = (url) => url.startsWith("http://localhost:3000/");
const decide = (over) => toolbar({ down: false, url: undefined, hasScripts: false, claimed, ...over });

test("on a claimed page with the scripts running, it toggles pick mode", () => {
  assert.equal(decide({ url: "http://localhost:3000/", hasScripts: true }), "pick");
});

test("on a claimed page without the scripts yet (activeTab only), it injects them, then picks", () => {
  assert.equal(decide({ url: "http://localhost:3000/a" }), "inject");
});

test("on an unclaimed page, or one whose URL Chrome doesn't give, it opens the side panel", () => {
  assert.equal(decide({ url: "http://localhost:4000/" }), "side-panel");
  assert.equal(decide({ url: "http://localhost:4000/", hasScripts: true }), "side-panel");
  assert.equal(decide({}), "side-panel");
});

test("while the bridge is down, it opens the side panel even on a claimed page", () => {
  assert.equal(decide({ down: true, url: "http://localhost:3000/", hasScripts: true }), "side-panel");
});
