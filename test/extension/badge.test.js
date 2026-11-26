// A tab's badge (design.md § Toolbar button): its page's open tweaks,
// counted and coloured by the most urgent, or the grey ! on an unclaimed
// page that looks like a dev server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GREY, URGENT, claimedBefore, tabBadge } from "../../extension/lib/badge.js";

const claims = [{ id: 1, pattern: "http://localhost:3000/*" }];
const tweak = (number, status, page = "http://localhost:3000/") => ({ number, status, page });
const tweaks = (...list) => new Map(list.map((t) => [t.number, t]));
const at = (url, list = tweaks(), before = []) => tabBadge({ url, claims, tweaks: list, before });

test("a claimed page counts its open tweaks, coloured by the most urgent: question, then working, then sent", () => {
  assert.deepEqual(at("http://localhost:3000/", tweaks(tweak(1, "sent"))), { text: "1", color: URGENT.sent });
  assert.deepEqual(at("http://localhost:3000/", tweaks(tweak(1, "queued"), tweak(2, "working"))), { text: "2", color: URGENT.working });
  assert.deepEqual(at("http://localhost:3000/?q=1#x", tweaks(tweak(1, "working"), tweak(2, "question"), tweak(3, "delivered"))), {
    text: "3",
    color: URGENT.question,
  });
});

test("finished tweaks, and those of other pages, aren't counted; none open is no badge", () => {
  const list = tweaks(tweak(1, "done"), tweak(2, "declined"), tweak(3, "withdrawn"), tweak(4, "sent", "http://localhost:3000/other"));
  assert.deepEqual(at("http://localhost:3000/", list), { text: "", color: GREY });
});

test("an unclaimed page that looks like a dev server gets the grey !", () => {
  for (const url of ["http://localhost:5173/", "https://127.0.0.1/", "http://app.localhost/", "https://bert.test/x", "http://lvh.me:3000/", "http://a.lvh.me/"]) {
    assert.deepEqual(at(url), { text: "!", color: GREY }, url);
  }
});

test("other websites, and pages that aren't websites, get no badge", () => {
  for (const url of ["https://example.com/", "https://localhost.example.com/", "https://test.dev/", "chrome://newtab/", "about:blank", undefined]) {
    assert.deepEqual(at(url), { text: "", color: GREY }, String(url));
  }
});

test("an origin claimed before gets the grey ! once its claim has gone", () => {
  const before = claimedBefore([], [{ pattern: "https://*.bert.example/admin/*" }]);
  assert.deepEqual(before, ["https://*.bert.example/*"]);
  assert.deepEqual(at("https://app.bert.example/home", tweaks(), before), { text: "!", color: GREY });
  assert.deepEqual(at("https://ernie.example/", tweaks(), before), { text: "", color: GREY });
  // Adding the same origin again changes nothing.
  assert.equal(claimedBefore(before, [{ pattern: "https://*.bert.example/*" }]), before);
});
