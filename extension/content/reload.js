// Reloading after a change (docs/design.md, "Reloading after a change"). The
// page shows a change by the dev server's own hot update when there is one,
// otherwise by one reload from here. From the moment a tweak enters working
// (or its undo goes to Claude, or Undo is pressed) the tab records update
// signals: a <link> or <style> swap, Vite's vite:afterUpdate (relayed by the
// page probe as tweak:updated), and a full reload, noticed when the card
// open before it comes back with its tweak still under way. About a second
// after done (or undone) the page reloads only if no signal arrived since.
// The reload is held back while the developer is in the middle of
// something, or the site's auto-reload is off; the card then shows
// "Change saved · Reload" with the reason, and the reload happens by itself
// once nothing holds it.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  const WAIT_MS = 1000; // after done, for a hot update to land
  const RECHECK_MS = 500; // while a reload is held back
  const IN_PROGRESS = new Set(["sent", "delivered", "queued", "working", "question"]);

  // ---- Decisions (pure) ----

  // moment says what a tweak's change from was to now means here: "watch"
  // (Claude is working: record signals), "undo" (its undo is with Claude),
  // "settle" (done or undone: decide whether to reload), "declined" (Claude
  // declined the undo: the change stands), "withdrawn" (its reload, if any,
  // is dropped) or null. A tweak that changed nothing, by the git check,
  // settles nothing, and a withdrawn one only by being undone.
  function moment(was, now) {
    const state = (t) => t?.change?.state;
    // An undo comes first: a resolved or withdrawn tweak can still be undone.
    if (state(now) === "undone" && state(was) !== "undone") return "settle";
    if (state(now) === "undo-requested" && state(was) !== "undo-requested") return "undo";
    if (state(was) === "undo-requested" && state(now) !== "undo-requested") return "declined";
    if (now.status === "withdrawn") return was && was.status !== "withdrawn" ? "withdrawn" : null;
    if (now.status === "working" && was?.status !== "working") return "watch";
    // Only a tweak the tab had can end here: one it hasn't (resolved, and
    // gone from the page) settles only by being undone.
    const ended = was && (now.status === "done" || now.status === "declined") && was.status !== now.status;
    if (!ended) return null;
    const c = ns.describe.change(now);
    if (now.status === "done" && !now.change) return "settle"; // nothing recorded either way
    return c && c.kind !== "unchanged" ? "settle" : null;
  }

  // signalled is the first signal since watch.from ({at, kind}), the
  // reload itself for a watch begun on a reloaded page, or null.
  const signalled = (watch, signals) => (watch.reloaded ? { kind: "reload" } : (signals.find((s) => s.at >= watch.from) ?? null));

  // reason is what holds a reload back, as the card says it, or "".
  function reason({ auto, drafting, layer, unsaved: dirty, others }) {
    if (!auto) return "auto-reload is off for this site";
    if (drafting) return `you're writing a ${drafting}`;
    if (layer) return `a ${layer} is open`;
    if (dirty) return "a form on the page has unsaved input";
    if (others.length === 1) return `tweak ${others[0]} is still in progress`;
    if (others.length) return `tweaks ${others.slice(0, -1).join(", ")} and ${others.at(-1)} are still in progress`;
    return "";
  }

  // unsaved says whether any of the page's fields differs from what the page
  // loaded with: typed text, a box ticked, another option chosen. (A field a
  // framework controls keeps its default in step, so it never counts.)
  // initial is the value a field starts with: its default, except where the
  // browser sanitises that (an empty range starts at its midpoint).
  const UNTYPED = new Set(["hidden", "submit", "button", "reset", "image"]);
  function unsaved(fields, initial = (f) => f.defaultValue) {
    for (const f of fields) {
      if (f.tagName === "SELECT") {
        const options = [...f.options];
        const marked = options.some((o) => o.defaultSelected);
        // Without a default, a drop-down starts on its first option; a
        // multiple select or a listbox (size over 1) starts with none.
        const dropDown = !f.multiple && !(f.size > 1);
        const first = dropDown && !marked ? options.findIndex((o) => !o.disabled) : -1;
        if (options.some((o, i) => o.selected !== (first < 0 ? o.defaultSelected : i === first))) return true;
        continue;
      }
      const type = (f.type || "text").toLowerCase();
      if (f.tagName === "INPUT" && UNTYPED.has(type)) continue;
      if (type === "checkbox" || type === "radio") {
        if (f.checked !== f.defaultChecked) return true;
      } else if (f.value !== initial(f)) return true;
    }
    return false;
  }

  // inProgress are the numbers of the tweaks a reload waits for: open ones,
  // and finished ones whose undo is still with Claude; not those in waiting.
  const inProgress = (tweaks, waiting) =>
    tweaks.filter((t) => (IN_PROGRESS.has(t.status) || t.change?.state === "undo-requested") && !waiting.has(t.number)).map((t) => t.number);

  ns.reload = { moment, signalled, reason, unsaved, inProgress, WAIT_MS };
  if (typeof document === "undefined") return; // the decisions alone, in node

  // ---- The page ----
  //
  // One machine per tweak, by number, driven only by what the tab hears:
  // the tweak's events (working, done, its undo with Claude, undone, the
  // undo declined), the answer to an Undo pressed in this tab (or the port
  // going before it came), the page left, and the hold reasons as check()
  // reads them. A tweak with no machine has nothing to do with the reload.
  // - watching {from, reloaded, owed, undo}: signals count from `from`;
  //   `undo` while an undo is under way (pressed, or with Claude), which
  //   holds every reload back; `owed` when the change before the undo still
  //   needs its reload, should the undo not happen.
  // - deciding {from, reloaded, owed, timer}: done or undone; WAIT_MS later
  //   it's dropped if a signal arrived since `from` (and nothing is owed),
  //   or else held.
  // - held: its change needs a reload, which check() makes once nothing
  //   holds it back. The page reloads once; then nothing is left to do.
  // The card only reads it (notice), for "Change saved · Reload".

  const machines = new Map();
  const signals = []; // the latest signal, {at, kind}, while a tweak is watched or deciding
  const presses = new Map(); // ref -> number: Undo pressed here, its answer on the way
  let reloading = false;
  let held = ""; // why the reload waits, or ""
  let recheck = 0;
  let observer = null;

  const listening = () => [...machines.values()].some((m) => m.state !== "held");
  const signal = (kind) => {
    // Only the latest counts: any signal since a watch began will do.
    if (listening()) signals.splice(0, signals.length, { at: performance.now(), kind });
  };

  // A <link> or <style> added, removed or changed anywhere in the document.
  const sheet = (n) => n.nodeName === "STYLE" || (n.nodeName === "LINK" && /\bstylesheet\b/i.test(n.rel ?? ""));
  function sawSheets(records) {
    for (const r of records) {
      if (sheet(r.target)) return true;
      for (const n of r.addedNodes) if (sheet(n)) return true;
      for (const n of r.removedNodes) if (sheet(n)) return true;
    }
    return false;
  }

  // The observer runs only while a signal could count.
  function observe() {
    if (listening() && !observer) {
      observer = new MutationObserver((records) => sawSheets(records) && signal("style"));
      observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "rel"] });
    } else if (!listening() && observer) {
      observer.disconnect();
      observer = null;
      signals.length = 0;
    }
  }

  const onUpdated = () => signal("vite");
  document.addEventListener("tweak:updated", onUpdated);

  // set puts tweak number's machine in its next state (or none), and lets
  // the rest catch up.
  function set(number, next) {
    const m = machines.get(number);
    if (m?.timer) clearTimeout(m.timer);
    if (next) machines.set(number, next);
    else machines.delete(number);
    observe();
    check();
  }

  // owes says whether the change a machine stands for still needs a reload
  // if what comes next (an undo) doesn't happen: it's held, or deciding
  // with nothing seen yet, or already owed.
  const owes = (m) => Boolean(m && (m.owed || m.state === "held" || (m.state === "deciding" && !signalled(m, signals))));

  // working: Claude is on it; signals count from now.
  function working(number, { reloaded = false } = {}) {
    const m = machines.get(number);
    if (m?.state === "watching" && !m.undo) return;
    set(number, { state: "watching", from: performance.now(), reloaded, owed: owes(m), undo: false });
  }

  // undoing: an undo is under way, pressed here or with Claude.
  // via is "press" (Undo pressed here, its answer on the way) or "claude"
  // (the undo is with Claude, which can only end in an event).
  function undoing(number, { reloaded = false, via = "claude" } = {}) {
    const m = machines.get(number);
    if (m?.state === "watching" && m.undo) {
      m.undo = via === "claude" ? "claude" : m.undo;
      return;
    }
    set(number, { state: "watching", from: performance.now(), reloaded, owed: owes(m), undo: via });
  }

  // ended: done or undone. It decides a moment later.
  function ended(number) {
    const m = machines.get(number);
    const watched = m?.state === "watching";
    const next = {
      state: "deciding",
      from: watched ? m.from : performance.now(),
      reloaded: watched && m.reloaded,
      owed: Boolean(m?.owed) || m?.state === "held",
    };
    next.timer = setTimeout(() => {
      if (machines.get(number) !== next) return;
      const seen = signalled(next, signals);
      ns.reload.last = { number, signal: seen?.kind ?? null };
      set(number, seen && !next.owed ? null : { state: "held" });
    }, WAIT_MS);
    set(number, next);
  }

  // notUndone: the undo didn't happen (refused, or declined by Claude), so
  // the change before it stands: its reload, if it was owed one, is back.
  function notUndone(number) {
    const m = machines.get(number);
    if (m?.state !== "watching" || !m.undo) return;
    set(number, m.owed ? { state: "held" } : null);
  }

  const auto = async () => {
    try {
      const { autoReload = {} } = await chrome.storage.local.get("autoReload");
      return autoReload[location.origin] !== false;
    } catch {
      return true; // the extension went away: nothing reads the setting
    }
  };

  // initial is what an input starts with: a fresh one with the same
  // attributes, which the browser sanitises the same way.
  function initial(f) {
    if (f.tagName !== "INPUT") return f.defaultValue;
    const fresh = document.createElement("input");
    for (const a of f.attributes) fresh.setAttribute(a.name, a.value);
    return fresh.value;
  }

  function layer() {
    if (document.querySelector("dialog[open]")) return "dialog";
    try {
      for (const el of document.querySelectorAll(":popover-open")) if (el !== ns.overlay.host) return "popover";
    } catch {}
    return "";
  }

  const isHeld = () => [...machines.values()].some((m) => m.state === "held");

  // check reloads the page if a change waits for one and nothing holds it
  // back, or says why it waits, and looks again shortly. Everything but the
  // setting is read after the setting, so it's all as of the same moment.
  let checks = 0; // the latest check decides; one overtaken by another stops
  async function check() {
    clearTimeout(recheck);
    const mine = ++checks;
    if (reloading || !isHeld()) return show("");
    const on = await auto();
    if (mine !== checks) return;
    if (reloading || !isHeld()) return show("");
    const waiting = new Set([...machines].filter(([, m]) => m.state === "held").map(([n]) => n));
    const undoing = [...machines].filter(([, m]) => m.undo).map(([n]) => n);
    const others = [...new Set([...inProgress(ns.page.tweaks?.() ?? [], waiting), ...undoing])].sort((a, b) => a - b);
    const why = reason({
      auto: on,
      drafting: ns.panel.drafting?.() ?? "",
      layer: layer(),
      unsaved: unsaved(document.querySelectorAll("input, textarea, select"), initial),
      others,
    });
    if (!why) return reload();
    show(why);
    recheck = setTimeout(check, RECHECK_MS);
  }

  function reload() {
    if (reloading) return;
    reloading = true;
    for (const m of machines.values()) if (m.timer) clearTimeout(m.timer);
    machines.clear();
    observe();
    ns.reload.last = { ...ns.reload.last, reloaded: true };
    show("");
    location.reload();
  }

  function show(why) {
    if (why === held) return;
    held = why;
    ns.panel.update();
  }

  Object.assign(ns.reload, {
    // heard is a tweak's event: was is the tweak before it, if the tab had it.
    heard(was, now) {
      const m = moment(was, now);
      if (m === "watch") working(now.number);
      if (m === "undo") undoing(now.number);
      if (m === "settle") ended(now.number);
      if (m === "declined") notUndone(now.number);
      if (m === "withdrawn") set(now.number, null);
      // A resolved tweak has left the page, so its declined undo comes with
      // no tweak before it: the machine knows the undo was with Claude.
      if (m === null && !was && machines.get(now.number)?.undo === "claude" && now.change?.state !== "undo-requested") notUndone(now.number);
    },
    // loaded is the page's first list of tweaks, with the card open before
    // the load: if its tweak is still under way, the load was a full reload
    // since working.
    loaded(tweaks, card) {
      for (const t of tweaks) {
        const reloaded = t.number === card;
        if (t.status === "working") working(t.number, { reloaded });
        else if (t.change?.state === "undo-requested") undoing(t.number, { reloaded });
      }
    },
    // pressed is Undo pressed in this tab on tweak (its request's ref): the
    // files may change before the answer comes.
    pressed(tweak, ref) {
      // Only for this page, while it's claimed: an open card's tweak from
      // another page reloads nothing here, and its events don't reach here.
      if (!ns.page.here?.(tweak)) return;
      presses.set(ref, tweak.number);
      undoing(tweak.number, { via: "press" });
    },
    // undid is the bridge's answer to an Undo pressed here: refused (no
    // number), the undo didn't happen. Taken, its undone or its undo with
    // Claude follows as an event.
    undid(msg) {
      const number = presses.get(msg.ref);
      if (number === undefined) return;
      presses.delete(msg.ref);
      if (!msg.number) notUndone(number);
    },
    // closed: the worker's port went, and with it the answers on their way.
    closed() {
      const lost = [...presses.values()];
      presses.clear();
      for (const n of lost) notUndone(n);
    },
    // left drops everything the old page was waiting for: the tab has moved
    // to another page, or gone dormant (a reload there would show no change).
    left() {
      for (const m of machines.values()) if (m.timer) clearTimeout(m.timer);
      machines.clear();
      presses.clear();
      observe();
      check();
    },
    // notice is what the card of tweak number says about the page's
    // reload: {why} while it's held back, or null.
    notice: (number) => (held && machines.get(number)?.state === "held" ? { why: held } : null),
    // state is tweak number's machine state, for tests: "watching",
    // "deciding", "held" or null.
    state: (number) => machines.get(number)?.state ?? null,
    // now reloads at once: the card's Reload.
    now: () => reload(),
    recheck: () => check(),
  });

  ns.teardowns.push(() => {
    document.removeEventListener("tweak:updated", onUpdated);
    observer?.disconnect();
    clearTimeout(recheck);
    for (const m of machines.values()) if (m.timer) clearTimeout(m.timer);
  });
})();
