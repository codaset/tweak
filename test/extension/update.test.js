// The extension's self-update decisions (docs/design.md, "The extension
// updates itself").
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, justUpdated } from "../../extension/lib/update.js";

test("a development bridge sends no version, so the extension never reloads", () => {
  assert.equal(decide({ own: "1.1.0", bridge: undefined, expected: undefined, busy: false }), "none");
  assert.equal(decide({ own: "1.1.0", bridge: undefined, expected: "1.2.0", busy: false }), "none");
});

test("the bridge's own version is current", () => {
  assert.equal(decide({ own: "1.2.0", bridge: "1.2.0", expected: undefined, busy: false }), "current");
});

test("another version reloads", () => {
  assert.equal(decide({ own: "1.1.0", bridge: "1.2.0", expected: undefined, busy: false }), "reload");
});

test("the reload waits while you're in the middle of something", () => {
  assert.equal(decide({ own: "1.1.0", bridge: "1.2.0", expected: undefined, busy: true }), "wait");
});

test("still another version after reloading for it: loaded from another folder", () => {
  assert.equal(decide({ own: "1.1.0", bridge: "1.2.0", expected: "1.2.0", busy: false }), "stuck");
});

test("a stuck extension tries again when the bridge moves to a newer version", () => {
  assert.equal(decide({ own: "1.1.0", bridge: "1.3.0", expected: "1.2.0", busy: false }), "reload");
});

test("the start after a reload into the expected version is an update", () => {
  assert.equal(justUpdated({ own: "1.2.0", expected: "1.2.0" }), true);
});

test("an ordinary start, or one still at the old version, isn't", () => {
  assert.equal(justUpdated({ own: "1.2.0", expected: undefined }), false);
  assert.equal(justUpdated({ own: "1.1.0", expected: "1.2.0" }), false);
});
