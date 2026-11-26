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
  assert.equal(moment(done, { ...done, change: { ...recorded, state: "undo-requested" } }), "undo");
});

test("the decision comes once Claude is done, or a change is undone", () => {
  assert.equal(moment({ status: "working" }, { status: "done", change: recorded }), "settle");
  const done = { status: "done", change: recorded };
  assert.equal(moment(done, { ...done, entries: [] }), null, "done again is no new change");
  assert.equal(moment(done, { ...done, change: { ...recorded, state: "undone" } }), "settle");
  const asked = { ...done, change: { ...recorded, state: "undo-requested" } };
  assert.equal(moment(asked, { ...done, change: { ...recorded, state: "undone" } }), "settle", "Claude's tweak undone");
  assert.equal(moment(asked, done), "declined", "Claude declined the undo: the change stands");
  // A resolved tweak has left the tab, and an Undo from the side panel's
  // resolved list still reloads it; any other event about one doesn't.
  assert.equal(moment(undefined, { ...done, change: { ...recorded, state: "undone" } }), "settle");
  assert.equal(moment(undefined, done), null);
});

test("a withdrawn tweak never reloads the page, unless its change is undone", () => {
  const withdrawn = { status: "withdrawn", change: recorded, resolvedAt: "2026-11-26T10:00:00Z" };
  assert.equal(moment({ status: "working" }, withdrawn), "withdrawn");
  assert.equal(moment(withdrawn, { ...withdrawn, entries: [] }), null);
  // The side panel's resolved list undoes it: the tab no longer has it.
  assert.equal(moment(undefined, { ...withdrawn, change: { ...recorded, state: "undone" } }), "settle");
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
// onReload, if given, is called as the page reloads (to check what holds).
function page({ onReload } = {}) {
  const timers = new Map();
  let id = 0;
  let now = 0;
  const reloads = [];
  const settings = { autoReload: {} };
  let read = null; // what the page last read of the settings
  const tweaks = new Map();
  const ns = { ready: false, teardowns: [], overlay: { host: null } };
  ns.page = { tweaks: () => [...tweaks.values()] };
  const flags = { drafting: "" };
  ns.panel = { update() {}, drafting: () => flags.drafting };
  const listeners = new Map();
  const document = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const context = {
    codasetTweak: ns,
    document,
    location: {
      origin: "http://localhost:3000",
      reload: () => {
        onReload?.();
        reloads.push(now);
      },
    },
    performance: { now: () => now },
    setTimeout: (fn, ms) => (timers.set(++id, { fn, at: now + ms }), id),
    clearTimeout: (t) => timers.delete(t),
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    chrome: { storage: { local: { get: async () => (read = structuredClone(settings)) } } },
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
  // event is a tweak's event as page.js passes it on: heard first, then a
  // resolved tweak leaves the page.
  const event = (tweak) => {
    const was = tweaks.get(tweak.number);
    ns.reload.heard(was, tweak);
    if (tweak.resolvedAt) tweaks.delete(tweak.number);
    else tweaks.set(tweak.number, tweak);
  };
  // signal is the probe's tweak:updated: a hot update landed.
  const signal = () => listeners.get("tweak:updated")?.();
  return { ns, event, advance, reloads, settings, flags, signal, read: () => read };
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
  p.ns.reload.pressed(1, "u1"); // Undo pressed
  p.ns.reload.undid({ ref: "u1", error: "refused" }); // and refused
  await p.advance(100);
  assert.equal(p.ns.reload.notice(1)?.why, "auto-reload is off for this site");
});

test("an Undo refused within the second after done leaves done's decision to it", async () => {
  const p = page();
  const tweak = { number: 1, page: "http://localhost:3000/" };
  p.event({ ...tweak, status: "working" });
  p.event({ ...tweak, status: "done", change: recorded });
  await p.advance(300);
  p.ns.reload.pressed(1, "u1"); // Undo pressed
  p.ns.reload.undid({ ref: "u1", error: "refused" }); // and refused
  await p.advance(2000);
  assert.equal(p.reloads.length, 1);
});

test("an Undo refused after done's second still gets done its reload", async () => {
  const p = page();
  const tweak = { number: 1, page: "http://localhost:3000/" };
  p.event({ ...tweak, status: "working" });
  p.event({ ...tweak, status: "done", change: recorded });
  await p.advance(300);
  p.ns.reload.pressed(1, "u1"); // Undo pressed
  await p.advance(1000);
  p.ns.reload.undid({ ref: "u1", error: "refused" }); // refused, after the second
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

test("an Undo refused after its card has closed still gives the change its reload", async () => {
  // The card isn't part of this: the refusal reaches reload.js from page.js.
  const p = page();
  const origin = "http://localhost:3000";
  p.settings.autoReload[origin] = false;
  const tweak = { number: 1, page: `${origin}/` };
  p.event({ ...tweak, status: "working" });
  p.event({ ...tweak, status: "done", change: recorded });
  await p.advance(2000);
  p.ns.reload.pressed(1, "u1");
  p.ns.reload.closed(); // the port went before the answer came
  delete p.settings.autoReload[origin];
  await p.advance(1000);
  assert.equal(p.reloads.length, 1);
});

// The machine as a model: many orderings of the events the tab hears, on
// a page that never hot-updates (and, with signals, one that may). For
// each, the page reloads at most once, and never while an undo is under
// way or a hold reason stands. Without hot updates, a done or undone since
// the page was last left always gets its reload once nothing holds it, and
// nothing else reloads.
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function walk(seed, { signals }) {
  const rand = random(seed);
  const origin = "http://localhost:3000";
  // The world as the bridge and the developer have it; owed1 and owed3 are
  // a done or undone of tweak 1 or 3 since the page was last left (or, for
  // a withdrawn tweak, since it was withdrawn).
  // undone since the page was last left.
  const m = { t1: null, press: null, claude: false, auto: true, other: false, draft: false, owed1: false, owed3: false, refs: 0 };
  const broken = [];
  const p = page({
    onReload: () => {
      if (m.press) broken.push("reloaded while an Undo's answer was on its way");
      if (m.claude) broken.push("reloaded while the undo was with Claude");
      // As of the page's last read: the switch can turn while it reads.
      if (p.read()?.autoReload[origin] === false) broken.push("reloaded with auto-reload off");
      if (m.other) broken.push("reloaded while another tweak was in progress");
      if (m.t3 === "working" || m.t1?.status === "working") broken.push("reloaded while Claude was working on a tweak");
      if (m.draft) broken.push("reloaded while a reply was being written");
    },
  });
  const t1 = (o) => {
    m.t1 = { number: 1, page: `${origin}/`, ...o };
    p.event(m.t1);
  };
  const changed = (state) => ({ ...recorded, state });
  const recordedNow = () => m.t1?.change?.state === "recorded" && m.t1.status === "done" && !m.t1.resolvedAt;
  const resolvedAt = "2026-11-26T10:00:00Z";
  const acts = {
    work() {
      if (m.t1?.status === "working" || m.t1?.resolvedAt || m.press || m.claude) return false;
      t1({ status: "working" });
      return true;
    },
    done() {
      if (m.t1?.status !== "working") return false;
      t1({ status: "done", change: recorded });
      return (m.owed1 = true);
    },
    press() {
      if (!recordedNow() || m.press || m.claude) return false;
      m.press = `u${++m.refs}`;
      p.ns.reload.pressed(1, m.press);
      return true;
    },
    refuse() {
      if (!m.press) return false;
      p.ns.reload.undid({ ref: m.press, error: "no" });
      m.press = null;
      return true;
    },
    undo() {
      // The bridge undoes it: its event, then its answer.
      if (!m.press) return false;
      const ref = m.press;
      m.press = null;
      t1({ status: "done", change: changed("undone") });
      p.ns.reload.undid({ ref, number: 1 });
      return (m.owed1 = true);
    },
    conflict() {
      if (!m.press) return false;
      const ref = m.press;
      m.press = null;
      m.claude = true;
      t1({ status: "done", change: changed("undo-requested") });
      p.ns.reload.undid({ ref, number: 1 });
      return true;
    },
    closed() {
      if (!m.press) return false;
      m.press = null;
      p.ns.reload.closed();
      return true;
    },
    ask() {
      if (!recordedNow() || m.press || m.claude) return false;
      m.claude = true;
      t1({ status: "done", change: changed("undo-requested") });
      return true;
    },
    undone() {
      if (!m.claude) return false;
      m.claude = false;
      t1({ status: "done", change: changed("undone") });
      return (m.owed1 = true);
    },
    decline() {
      if (!m.claude) return false;
      m.claude = false;
      t1({ status: "done", change: recorded });
      return true;
    },
    auto() {
      m.auto = !m.auto;
      if (m.auto) delete p.settings.autoReload[origin];
      else p.settings.autoReload[origin] = false;
      return true;
    },
    other() {
      m.other = !m.other;
      p.event({ number: 2, page: `${origin}/`, status: m.other ? "working" : "done", change: { state: "recorded", checked: true, files: [], unrecorded: [] } });
      return true;
    },
    draft() {
      m.draft = !m.draft;
      p.flags.drafting = m.draft ? "reply" : "";
      return true;
    },
    // Withdraw and Resolve (#41): a withdrawn tweak never reloads the page;
    // a resolved one leaves it, and the side panel can still undo it.
    withdraw() {
      if (m.t1?.status !== "working") return false;
      t1({ status: "withdrawn", resolvedAt });
      m.owed1 = false;
      return true;
    },
    resolve() {
      if (!recordedNow() || m.press || m.claude) return false;
      t1({ ...m.t1, resolvedAt });
      return true;
    },
    panelUndo() {
      if (!m.t1?.resolvedAt || m.t1.change?.state !== "recorded") return false;
      t1({ ...m.t1, change: changed("undone") });
      return (m.owed1 = true);
    },
    // A second tweak that changes the page, so one can be held while the
    // first is being undone.
    work3() {
      if (m.t3 === "working") return false;
      m.t3 = "working";
      p.event({ number: 3, page: `${origin}/`, status: "working" });
      return true;
    },
    done3() {
      if (m.t3 !== "working") return false;
      m.t3 = "done";
      p.event({ number: 3, page: `${origin}/`, status: "done", change: recorded });
      return (m.owed3 = true);
    },
    leave() {
      p.ns.reload.left();
      m.owed1 = m.owed3 = false;
      return true;
    },
    signal() {
      if (!signals) return false;
      p.signal();
      return true;
    },
    async wait() {
      await p.advance(Math.floor(rand() * 1500));
      return true;
    },
  };
  const names = Object.keys(acts);
  const steps = [];
  for (let i = 0; i < 20 && !p.reloads.length; i++) {
    const name = names[Math.floor(rand() * names.length)];
    if (await acts[name]()) steps.push(name);
  }
  if (!p.reloads.length) {
    // Let everything finish, and nothing hold the reload back.
    if (m.t1?.status === "working") acts.done();
    if (m.t3 === "working") acts.done3();
    if (m.press) acts.undo();
    if (m.claude) acts.undone();
    if (!m.auto) acts.auto();
    if (m.other) acts.other();
    if (m.draft) acts.draft();
  }
  await p.advance(3000);
  const why = `seed ${seed}: ${steps.join(" ")}`;
  assert.deepEqual(broken, [], why);
  assert.ok(p.reloads.length <= 1, `${why}: reloaded ${p.reloads.length} times`);
  const owed = m.owed1 || m.owed3;
  if (!signals) assert.equal(p.reloads.length, owed ? 1 : 0, `${why}: ${owed ? "a change never got its reload" : "a reload for no change"}`);
}

test("the reload machine as a model: at most once, never while held, always once nothing holds it", async () => {
  for (let seed = 1; seed <= 6000; seed++) await walk(seed, { signals: false });
});

test("the reload machine as a model, with hot updates: at most once, never while held", async () => {
  for (let seed = 1; seed <= 6000; seed++) await walk(seed, { signals: true });
});
