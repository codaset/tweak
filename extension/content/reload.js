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
  // (start recording signals), "settle" (decide whether to reload) or null.
  // A tweak that changed nothing, by the git check, settles nothing.
  function moment(was, now) {
    const state = (t) => t?.change?.state;
    if (now.status === "working" && was?.status !== "working") return "watch";
    if (state(now) === "undo-requested" && state(was) !== "undo-requested") return "watch";
    // Claude declined the undo: the change stands, and is decided again.
    if (state(was) === "undo-requested" && state(now) !== "undo-requested" && state(now) !== "undone") return "settle";
    if (state(now) === "undone" && state(was) !== "undone") return "settle";
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

  const watches = new Map(); // number -> {from, reloaded}
  const signals = []; // the latest signal, {at, kind}, while any tweak is watched
  const pending = new Set(); // tweaks whose change the page doesn't show yet
  const suspended = new Set(); // pending ones whose undo is under way: owed a reload still
  let held = ""; // why the reload waits, or ""
  let recheck = 0;
  let observer = null;
  const waits = new Set();

  const signal = (kind) => {
    // Only the latest counts: any signal since a watch began will do.
    if (watches.size) signals.splice(0, signals.length, { at: performance.now(), kind });
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

  // The observer runs only while a tweak is watched.
  function observe() {
    if (watches.size && !observer) {
      observer = new MutationObserver((records) => sawSheets(records) && signal("style"));
      observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "rel"] });
    } else if (!watches.size && observer) {
      observer.disconnect();
      observer = null;
      signals.length = 0;
    }
  }

  const onUpdated = () => signal("vite");
  document.addEventListener("tweak:updated", onUpdated);

  // A watch being settled is left to its decision: a new one (an Undo
  // within the second after done) starts afresh.
  function watch(number, { reloaded = false } = {}) {
    const was = watches.get(number);
    const keep = was && !was.settling;
    watches.set(number, {
      from: keep && !reloaded ? was.from : performance.now(),
      reloaded: reloaded || Boolean(keep && was.reloaded),
      replaced: keep ? was.replaced : was, // the settlement it takes over, if any
    });
    observe();
    // A reload it was waiting for (held back) waits for this change instead,
    // and is still owed if the undo doesn't happen.
    if (pending.delete(number)) {
      suspended.add(number);
      check();
    }
  }

  // settle decides, a moment after done or undone, whether the page needs
  // reloading for this tweak's change.
  function settle(number) {
    if (!watches.has(number) || watches.get(number).settling) watch(number);
    const w = watches.get(number);
    w.settling = true;
    const wait = setTimeout(() => {
      waits.delete(wait);
      w.due = true;
      // A newer watch (an undo begun meanwhile) takes over the decision,
      // and a page left meanwhile has none to make.
      if (watches.get(number) === w) decide(number, w);
    }, WAIT_MS);
    waits.add(wait);
  }

  // decide ends watch w: the page has updated since it began, or it
  // needs reloading.
  function decide(number, w) {
    watches.delete(number);
    const seen = signalled(w, signals);
    const owed = suspended.delete(number);
    observe();
    ns.reload.last = { number, signal: seen?.kind ?? null };
    if (seen && !owed) return;
    pending.add(number);
    check();
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

  // check reloads the page if a change waits for one and nothing holds it
  // back, or says why it waits, and looks again shortly.
  async function check() {
    clearTimeout(recheck);
    if (!pending.size) return show("");
    const others = inProgress(ns.page.tweaks?.() ?? [], pending);
    const why = reason({
      auto: await auto(),
      drafting: ns.panel.drafting?.() ?? "",
      layer: layer(),
      unsaved: unsaved(document.querySelectorAll("input, textarea, select"), initial),
      others,
    });
    if (!pending.size) return show("");
    if (!why) {
      ns.reload.last = { ...ns.reload.last, reloaded: true };
      location.reload();
      return;
    }
    show(why);
    recheck = setTimeout(check, RECHECK_MS);
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
      if (m === "watch") watch(now.number);
      if (m === "settle") settle(now.number);
    },
    // loaded is the page's first list of tweaks, with the card open before
    // the load: if its tweak is still under way, the load was a full reload
    // since working.
    loaded(tweaks, card) {
      for (const t of tweaks) {
        const underway = t.status === "working" || t.change?.state === "undo-requested";
        if (underway) watch(t.number, { reloaded: t.number === card });
      }
    },
    // watch starts recording for a tweak now: Undo pressed on its card;
    // unwatch stops, when the bridge refused that undo.
    watch: (number) => watch(number),
    unwatch(number) {
      // A settlement it took over gets its decision back.
      const replaced = watches.get(number)?.replaced;
      if (replaced) watches.set(number, replaced);
      else watches.delete(number);
      observe();
      if (replaced?.due) decide(number, replaced); // its second is already up
      if (suspended.delete(number)) {
        pending.add(number);
        check();
      }
    },
    // notice is what the card of tweak number says about the page's reload:
    // {why} while it's held back, or null.
    notice: (number) => (held && pending.has(number) ? { why: held } : null),
    // left drops what the old page was waiting for: the tab has moved to
    // another page (a reload there would show no change).
    left() {
      watches.clear();
      pending.clear();
      suspended.clear();
      for (const w of waits) clearTimeout(w);
      waits.clear();
      observe();
      check();
    },
    // now reloads at once: the card's Reload.
    now: () => location.reload(),
    recheck: () => pending.size && check(),
  });

  ns.teardowns.push(() => {
    document.removeEventListener("tweak:updated", onUpdated);
    observer?.disconnect();
    clearTimeout(recheck);
    for (const w of waits) clearTimeout(w);
  });
})();
