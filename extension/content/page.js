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

  const off = ns.worker.on((msg) => {
    switch (msg.type) {
      case "open": // the port (re)connected: say which page this is
        shownPage = pageKey();
        shownURL = urlKey();
        ns.worker.post({ type: "page", url: location.href });
        break;
      case "state":
        ns.panel.update();
        break;
      case "closed": // the worker's port is gone: a send in flight is lost with it
        ns.panel.unsent("Not connected to Tweak");
        break;
      case "tweaks":
        tweaks.clear();
        for (const t of msg.tweaks) tweaks.set(t.number, t);
        if (typeof msg.claimed === "boolean") setClaimed(msg.claimed); // absent: unchanged
        ns.page.redraw();
        // The card open before a reload; on a dormant page it opens hidden.
        if (msg.card && tweaks.has(msg.card) && !ns.panel.open() && ns.panel.showing() === null) ns.panel.show(msg.card);
        break;
      case "tweak":
        tweaks.set(msg.tweak.number, msg.tweak);
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
      ns.worker.post({ type: "page", url: location.href });
      return;
    }
    shownPage = pageKey();
    const card = ns.panel.showing();
    if (ns.panel.open() && card === null) ns.panel.close();
    for (const n of tweaks.keys()) if (n !== card) tweaks.delete(n);
    ns.page.redraw();
    ns.worker.post({ type: "page", url: location.href });
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
