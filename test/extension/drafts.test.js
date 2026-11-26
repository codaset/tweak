// The tab's drafts (content/drafts.js), loaded as the classic content script
// it is, with a stand-in for the worker's port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const src = readFileSync(new URL("../../extension/content/drafts.js", import.meta.url), "utf8");

function load() {
  const posted = [];
  const listeners = new Set();
  const ns = {
    ready: false,
    teardowns: [],
    worker: {
      post: (m) => posted.push(m),
      on(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
  };
  runInNewContext(src, { codasetTweak: ns, globalThis: { codasetTweak: ns } });
  const hear = (msg) => listeners.forEach((fn) => fn(msg));
  return { ns, posted, hear };
}

test("a reply draft belongs to the question it answers: a later question starts empty", () => {
  const { ns } = load();
  ns.drafts.setReply(7, "twice as", 1);
  assert.equal(ns.drafts.reply(7, 1), "twice as");
  assert.equal(ns.drafts.reply(7, 2), "", "the next question doesn't get the old answer");
});

test("after the worker's port comes back, the drafts are saved again, as edits meanwhile went nowhere", () => {
  const { ns, posted, hear } = load();
  hear({ type: "state", connection: "connected" });
  assert.deepEqual(posted, [], "nothing before the kept drafts are adopted: they'd be overwritten");
  ns.drafts.adopt({ compose: null, replies: { 7: { text: "twice", question: 1 } } });
  ns.drafts.setReply(7, "twice as", 1);
  posted.length = 0;
  hear({ type: "state", connection: "connected" });
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ type: "draft", draft: { compose: null, replies: { 7: { text: "twice as", question: 1 } } } }]);
});
