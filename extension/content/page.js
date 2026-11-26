// This page's tweaks, from the worker: it says which page this is when its
// port opens, and hears the page's tweaks, each change to one, whether any
// claim still covers the page, and the answers to its sends. It draws the
// pins, keeps the card in step, and runs the frame loop that keeps both on
// their elements as the page moves. On a page no claim covers (released, or
// navigated outside every claim) it goes dormant: no picker, no pins, and the
// card hides until a claim covers the page again.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  const tweaks = new Map(); // number -> tweak: this page's, and the open card's
  let frame = 0;
  let claimed = true; // the scripts run only on claimed pages; the worker says otherwise
  let draftsAdopted = false; // once this load has the drafts kept for its tab
  // The page is origin and path: the query and hash don't change it.
  const pageKey = () => `${location.origin}${location.pathname}`;
  let shownPage = pageKey();
  // Claims match the query too, so the worker hears of every new path or query.
  const urlKey = () => `${location.origin}${location.pathname}${location.search}`;
  let shownURL = urlKey();

  // list is the tweaks that get a pin: this page's, while it's claimed.
  const list = () =>
    claimed ? [...tweaks.values()].filter((t) => t.page === shownPage).sort((a, b) => a.number - b.number) : [];

  function loop() {
    frame = 0;
    if (!ns.pins.any() && !ns.panel.open()) return;
    ns.pins.position();
    ns.picker.follow();
    ns.panel.tick();
    frame = requestAnimationFrame(loop);
  }

  // setClaimed wakes the page, or puts it to sleep.
  function setClaimed(on) {
    if (on === claimed) return;
    claimed = on;
    if (!on) ns.picker.release();
    ns.panel.sleep(!on);
    ns.page.redraw();
  }
  ns.picker.enable(() => claimed);

  ns.page = {
    tweak: (number) => tweaks.get(number),
    // redraw puts the pins and card in step with the tweaks.
    redraw() {
      ns.pins.render(list());
      ns.panel.update();
      if (!frame) frame = requestAnimationFrame(loop);
    },
    // cardChanged tells the worker which card is open in this tab, so it
    // reopens in place after a reload.
    cardChanged(number) {
      ns.worker.post({ type: "card", number });
      if (!frame) frame = requestAnimationFrame(loop);
    },
  };

  // improvements are the side panel's suggestions for this page, once its
  // HTML has loaded: {suggestions}, or nothing before then. A page still
  // loading says them when it has.
  // A client-side navigation carries them for the new page; Turbo renders
  // its new body after the URL changes, so they're said again then.
  const improvements = () => (document.readyState === "loading" ? {} : { suggestions: ns.improvements.suggestions() });
  const sayImprovements = () => ns.worker.post({ type: "page", url: location.href, ...improvements() });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", sayImprovements, { once: true });
  document.addEventListener("turbo:load", sayImprovements);
  ns.teardowns.push(() => document.removeEventListener("turbo:load", sayImprovements));

  const off = ns.worker.on((msg) => {
    switch (msg.type) {
      case "open": // the port (re)connected: say which page this is
        shownPage = pageKey();
        shownURL = urlKey();
        ns.worker.post({ type: "page", url: location.href, ...improvements() });
        break;
      case "state": // connected or down: the pins and card fade while it's down
        ns.page.redraw();
        break;
      case "closed": // the worker's port is gone: a send in flight is lost with it
        ns.panel.unsent("Not connected to Tweak");
        break;
      case "tweaks":
        tweaks.clear();
        for (const t of msg.tweaks) tweaks.set(t.number, t);
        if (typeof msg.claimed === "boolean") setClaimed(msg.claimed); // absent: unchanged
        ns.page.redraw();
        // The drafts kept for this tab come with its first tweaks after a
        // load; a later port (a restarted worker) brings nothing new.
        // Only the answer to page carries them (a snapshot's tweaks don't).
        const adopting = !draftsAdopted && "draft" in msg;
        if (adopting) ns.drafts.adopt(msg.draft);
        // The card open before a reload; on a dormant page it opens hidden.
        if (msg.card && tweaks.has(msg.card) && !ns.panel.open() && ns.panel.showing() === null) ns.panel.show(msg.card);
        // Or the composer, with what you'd written.
        if (adopting && ns.panel.showing() === null && !ns.panel.open()) ns.panel.restore(ns.drafts.compose());
        if (adopting) draftsAdopted = true;
        break;
      case "tweak":
        // msg.event is the bridge's event: tweak-undone means a change was
        // undone, which reloads the page as after a change (#42). A
        // resolved tweak (resolved or withdrawn) leaves the page: its pin
        // goes, and its card closes.
        if (msg.tweak.resolvedAt) {
          tweaks.delete(msg.tweak.number);
          ns.panel.gone(msg.tweak);
        } else tweaks.set(msg.tweak.number, msg.tweak);
        ns.page.redraw();
        break;
      case "claimed":
        setClaimed(msg.claimed);
        break;
      case "asked": {
        // Claude has asked about a tweak. Its card opens here, in the tab it
        // was sent from, wherever that tab now is (ns.panel.asked: without
        // the focus, and never over a composer or a reply being written).
        // When that tab is gone, the tabs showing its page get a toast.
        const n = msg.tweak.number;
        tweaks.set(n, msg.tweak);
        ns.page.redraw();
        if (msg.toast) {
          if (claimed) ns.toast(`Claude has a question about tweak ${n}`);
        } else ns.panel.asked(n);
        break;
      }
      case "created":
        ns.panel.created(msg);
        break;
      case "replied":
        ns.panel.replied(msg);
        break;
      case "resent":
        ns.panel.resent(msg);
        break;
      case "undid":
        ns.panel.undid(msg);
        break;
      case "withdrew":
      case "resolved":
        ns.panel.finished(msg);
        break;
    }
  });

  // Client-side navigation (the page's own pushState included): a new path
  // is a new page, so its tweaks replace this one's, and the worker says
  // whether a claim covers it. The card stays open (it closes on esc or ×
  // only) and keeps its tweak; a composer belongs to the page it was opened
  // on, so it closes. A new query is the same page, but a claim may match
  // the query, so the worker hears of it too.
  const onNavigate = () => {
    if (urlKey() === shownURL) return;
    shownURL = urlKey();
    if (pageKey() === shownPage) {
      ns.worker.post({ type: "page", url: location.href, ...improvements() });
      return;
    }
    shownPage = pageKey();
    const card = ns.panel.showing();
    if (ns.panel.open() && card === null) ns.panel.close();
    for (const n of tweaks.keys()) if (n !== card) tweaks.delete(n);
    ns.page.redraw();
    ns.worker.post({ type: "page", url: location.href, ...improvements() });
  };
  globalThis.navigation?.addEventListener("currententrychange", onNavigate);

  // esc closes the panel wherever the focus is: on the page here, and in
  // the overlay (panel and pins) through ns.panel.onKey.
  const onKey = (e) => {
    if (e.key === "Escape" && ns.panel.open() && !ns.overlay.contains(e)) ns.panel.close();
  };
  window.addEventListener("keydown", onKey, true);

  ns.teardowns.push(() => {
    off();
    cancelAnimationFrame(frame);
    window.removeEventListener("keydown", onKey, true);
    globalThis.navigation?.removeEventListener("currententrychange", onNavigate);
  });
})();
