// Reloading after a change (design.md § Reloading after a change): the
// content script's decisions, loaded as the classic script it is. What it
// reads from a real page, and the reload itself, are proved end to end in
// the round trips (test/e2e).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const ns = { ready: false, teardowns: [] };
for (const file of ["describe.js", "reload.js"]) {
  const src = readFileSync(new URL(`../../extension/content/${file}`, import.meta.url), "utf8");
  runInNewContext(src, { codasetTweak: ns, globalThis: { codasetTweak: ns } });
}
const { moment, signalled, reason, unsaved, inProgress } = ns.reload;

const recorded = { state: "recorded", checked: true, files: [{ path: "a.html" }], unrecorded: [] };

test("signals are recorded from working, and from an undo with Claude", () => {
  assert.equal(moment({ status: "delivered" }, { status: "working" }), "watch");
  assert.equal(moment(undefined, { status: "working" }), "watch");
  assert.equal(moment({ status: "working" }, { status: "working" }), null, "a plan posted while working changes nothing");
  const done = { status: "done", change: recorded };
  assert.equal(moment(done, { ...done, change: { ...recorded, state: "undo-requested" } }), "watch");
});

test("the decision comes once Claude is done, or a change is undone", () => {
  assert.equal(moment({ status: "working" }, { status: "done", change: recorded }), "settle");
  const done = { status: "done", change: recorded };
  assert.equal(moment(done, { ...done, entries: [] }), null, "done again is no new change");
  assert.equal(moment(done, { ...done, change: { ...recorded, state: "undone" } }), "settle");
  const asked = { ...done, change: { ...recorded, state: "undo-requested" } };
  assert.equal(moment(asked, { ...done, change: { ...recorded, state: "undone" } }), "settle", "Claude's tweak undone");
  assert.equal(moment(asked, done), "settle", "Claude declined the undo: the change stands");
  // A resolved tweak has left the tab, and an Undo from the side panel's
  // resolved list still reloads it; any other event about one doesn't.
  assert.equal(moment(undefined, { ...done, change: { ...recorded, state: "undone" } }), "settle");
  assert.equal(moment(undefined, done), null);
});

test("a tweak that changed nothing doesn't reload", () => {
  const nothing = { state: "recorded", checked: true, files: [], unrecorded: [] };
  assert.equal(moment({ status: "working" }, { status: "done", change: nothing }), null);
  assert.equal(moment({ status: "working" }, { status: "declined", change: nothing }), null);
  // No repo to check: something may have changed.
  assert.equal(moment({ status: "working" }, { status: "done", change: { ...nothing, checked: false } }), "settle");
  assert.equal(moment({ status: "working" }, { status: "declined", change: recorded }), "settle", "declined after edits");
});

test("any signal since the watch began means the page has updated", () => {
  const signals = [
    { at: 100, kind: "style" },
    { at: 250, kind: "vite" },
  ];
  assert.equal(signalled({ from: 300 }, signals), null);
  assert.deepEqual({ ...signalled({ from: 200 }, signals) }, { at: 250, kind: "vite" });
  assert.deepEqual({ ...signalled({ from: 300, reloaded: true }, signals) }, { kind: "reload" }, "the page reloaded while its card was open");
});

test("the reload is held back while the developer is in the middle of something", () => {
  const clear = { auto: true, drafting: "", layer: "", unsaved: false, others: [] };
  assert.equal(reason(clear), "");
  assert.equal(reason({ ...clear, auto: false }), "auto-reload is off for this site");
  assert.equal(reason({ ...clear, unsaved: true }), "a form on the page has unsaved input");
  assert.equal(reason({ ...clear, layer: "dialog" }), "a dialog is open");
  assert.equal(reason({ ...clear, layer: "popover" }), "a popover is open");
  assert.equal(reason({ ...clear, drafting: "tweak" }), "you're writing a tweak");
  assert.equal(reason({ ...clear, drafting: "reply" }), "you're writing a reply");
  assert.equal(reason({ ...clear, others: [3] }), "tweak 3 is still in progress");
  assert.equal(reason({ ...clear, others: [3, 4] }), "tweaks 3 and 4 are still in progress");
  assert.equal(reason({ ...clear, others: [3, 4, 7] }), "tweaks 3, 4 and 7 are still in progress");
});

test("another tweak is in progress while Claude works on it, or is still undoing one", () => {
  const tweaks = [
    { number: 1, status: "done", change: { state: "recorded" } },
    { number: 2, status: "working" },
    { number: 3, status: "done", change: { state: "undo-requested" } },
    { number: 4, status: "declined" },
    { number: 5, status: "sent" },
  ];
  assert.deepEqual([...inProgress(tweaks, new Set([5]))], [2, 3], "the tweaks waiting for this reload aren't in the way");
});

test("unsaved input is a field that differs from what the page loaded with", () => {
  const input = (o) => ({ tagName: "INPUT", type: "text", value: "", defaultValue: "", ...o });
  assert.equal(unsaved([input({}), input({ value: "x", defaultValue: "x" })]), false);
  assert.equal(unsaved([input({ value: "typed" })]), true);
  assert.equal(unsaved([{ tagName: "TEXTAREA", value: "a\nb", defaultValue: "a" }]), true);
  assert.equal(unsaved([input({ type: "checkbox", checked: true, defaultChecked: false })]), true);
  assert.equal(unsaved([input({ type: "radio", checked: true, defaultChecked: true })]), false);
  // Buttons and hidden fields are never typed into.
  assert.equal(unsaved([input({ type: "hidden", value: "token" }), input({ type: "submit", value: "Go" })]), false);
  const option = (selected, defaultSelected = false) => ({ selected, defaultSelected, disabled: false });
  // A select with no option marked selected starts on its first.
  assert.equal(unsaved([{ tagName: "SELECT", options: [option(true), option(false)] }]), false);
  assert.equal(unsaved([{ tagName: "SELECT", options: [option(false), option(true)] }]), true);
  assert.equal(unsaved([{ tagName: "SELECT", options: [option(false), option(true, true)] }]), false);
  assert.equal(unsaved([{ tagName: "SELECT", multiple: true, options: [option(true), option(false)] }]), true, "a multiple select starts with none");
  assert.equal(unsaved([{ tagName: "SELECT", size: 2, options: [option(false), option(false)] }]), false, "so does a listbox");
  assert.equal(unsaved([{ tagName: "SELECT", size: 2, options: [option(true), option(false)] }]), true);
});

test("a field the browser gives a value of its own starts on that value, not on an empty default", () => {
  // An untouched range is "50" and a colour "#000000", with defaultValue "".
  const range = { tagName: "INPUT", type: "range", value: "50", defaultValue: "" };
  const initial = (f) => ({ range: "50", color: "#000000" })[f.type] ?? f.defaultValue;
  assert.equal(unsaved([range, { tagName: "INPUT", type: "color", value: "#000000", defaultValue: "" }], initial), false);
  assert.equal(unsaved([{ ...range, value: "70" }], initial), true);
});

// The page side, over a stand-in page with timers run by hand: what's
// waiting for a reload, and when it reloads.
function page() {
  const timers = new Map();
  let id = 0;
  let now = 0;
  const reloads = [];
  const settings = { autoReload: {} };
  const tweaks = new Map();
  const ns = { ready: false, teardowns: [], overlay: { host: null } };
  ns.page = { tweaks: () => [...tweaks.values()] };
  ns.panel = { update() {}, drafting: () => "" };
  const document = { addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
  const context = {
    codasetTweak: ns,
    document,
    location: { origin: "http://localhost:3000", reload: () => reloads.push(now) },
    performance: { now: () => now },
    setTimeout: (fn, ms) => (timers.set(++id, { fn, at: now + ms }), id),
    clearTimeout: (t) => timers.delete(t),
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    chrome: { storage: { local: { get: async () => structuredClone(settings) } } },
  };
  context.globalThis = context;
  for (const file of ["describe.js", "reload.js"]) runInNewContext(readFileSync(new URL(`../../extension/content/${file}`, import.meta.url), "utf8"), context);
  // advance runs every timer due within ms, letting each one's awaits settle.
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      await new Promise((r) => setImmediate(r));
      const [next] = [...timers].filter(([, t]) => t.at <= end).sort(([, a], [, b]) => a.at - b.at);
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
    await new Promise((r) => setImmediate(r));
  }
  // event is a tweak's event as page.js passes it on.
  const event = (tweak) => {
    const was = tweaks.get(tweak.number);
    ns.reload.heard(was, tweak);
    tweaks.set(tweak.number, tweak);
  };
  return { ns, event, advance, reloads, settings };
}

test("a held reload whose undo then goes to Claude waits for the undo, even once auto-reload is on", async () => {
  const p = page();
  const origin = "http://localhost:3000";
  p.settings.autoReload[origin] = false;
  const tweak = { number: 1, page: `${origin}/` };
  p.event({ ...tweak, status: "delivered" });
  p.event({ ...tweak, status: "working" });
  p.event({ ...tweak, status: "done", change: recorded });
  await p.advance(2000);
  assert.equal(p.ns.reload.notice(1)?.why, "auto-reload is off for this site", "held back");

  p.event({ ...tweak, status: "done", change: { ...recorded, state: "undo-requested" } });
  delete p.settings.autoReload[origin];
  await p.advance(2000);
  assert.deepEqual(p.reloads, [], "no reload while Claude is still undoing");

  p.event({ ...tweak, status: "done", change: { ...recorded, state: "undone" } });
  await p.advance(2000);
  assert.equal(p.reloads.length, 1, "one reload once the undo is done");
});

test("a held reload comes back when Claude declines the undo", async () => {
  const p = page();
  const origin = "http://localhost:3000";
  p.settings.autoReload[origin] = false;
  const tweak = { number: 1, page: `${origin}/` };
  p.event({ ...tweak, status: "working" });
  p.event({ ...tweak, status: "done", change: recorded });
  await p.advance(2000);
  p.event({ ...tweak, status: "done", change: { ...recorded, state: "undo-requested" } });
  await p.advance(2000);
  p.event({ ...tweak, status: "done", change: recorded }); // declined: the change stands
  await p.advance(2000);
  assert.equal(p.ns.reload.notice(1)?.why, "auto-reload is off for this site", "held back again");
  delete p.settings.autoReload[origin];
  await p.advance(1000);
  assert.equal(p.reloads.length, 1, "the change is shown once auto-reload is on");
});

test("a held reload comes back when the bridge refuses the Undo", async () => {
  const p = page();
  const origin = "http://localhost:3000";
  p.settings.autoReload[origin] = false;
  const tweak = { number: 1, page: `${origin}/` };
  p.event({ ...tweak, status: "working" });
  p.event({ ...tweak, status: "done", change: recorded });
  await p.advance(2000);
  p.ns.reload.watch(1); // Undo pressed
  p.ns.reload.unwatch(1); // and refused
  await p.advance(100);
  assert.equal(p.ns.reload.notice(1)?.why, "auto-reload is off for this site");
});

test("an Undo refused within the second after done leaves done's decision to it", async () => {
  const p = page();
  const tweak = { number: 1, page: "http://localhost:3000/" };
  p.event({ ...tweak, status: "working" });
  p.event({ ...tweak, status: "done", change: recorded });
  await p.advance(300);
  p.ns.reload.watch(1); // Undo pressed
  p.ns.reload.unwatch(1); // and refused
  await p.advance(2000);
  assert.equal(p.reloads.length, 1);
});

test("an Undo refused after done's second still gets done its reload", async () => {
  const p = page();
  const tweak = { number: 1, page: "http://localhost:3000/" };
  p.event({ ...tweak, status: "working" });
  p.event({ ...tweak, status: "done", change: recorded });
  await p.advance(300);
  p.ns.reload.watch(1); // Undo pressed
  await p.advance(1000);
  p.ns.reload.unwatch(1); // refused, after the second
  await p.advance(2000);
  assert.equal(p.reloads.length, 1);
});

test("leaving the page within the second after done drops its decision", async () => {
  const p = page();
  const tweak = { number: 1, page: "http://localhost:3000/" };
  p.event({ ...tweak, status: "working" });
  p.event({ ...tweak, status: "done", change: recorded });
  await p.advance(500);
  p.ns.reload.left();
  await p.advance(2000);
  assert.deepEqual(p.reloads, []);
});

test("an undo started within the second after done takes over that decision", async () => {
  const p = page();
  const tweak = { number: 1, page: "http://localhost:3000/" };
  p.event({ ...tweak, status: "working" });
  p.event({ ...tweak, status: "done", change: recorded });
  await p.advance(500);
  p.event({ ...tweak, status: "done", change: { ...recorded, state: "undo-requested" } });
  await p.advance(1500);
  assert.deepEqual(p.reloads, [], "no reload while Claude is still undoing");
  p.event({ ...tweak, status: "done", change: { ...recorded, state: "undone" } });
  await p.advance(2000);
  assert.equal(p.reloads.length, 1, "one reload once the undo is done");
});
