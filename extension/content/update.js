// The tab's half of the self-update (docs/design.md, "The extension updates
// itself"). ns.busy.set(reason, on) tells the worker this tab is in the
// middle of something (a composer open, pick mode on, an unsent draft), which
// holds a pending reload back; the worker hears {type: "busy", busy}. After
// an update, the worker sends {type: "updated", version} and the tab says so.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  const reasons = new Set();
  const post = () => ns.worker.post({ type: "busy", busy: reasons.size > 0 });

  ns.busy = {
    set(reason, on) {
      const was = reasons.size > 0;
      if (on) reasons.add(reason);
      else reasons.delete(reason);
      if (reasons.size > 0 !== was) post();
    },
  };

  const off = ns.worker.on((msg) => {
    // A state message follows every connect, so a restarted worker hears it again.
    if (msg.type === "state" && reasons.size > 0) post();
    if (msg.type === "updated") ns.toast(`Codaset Tweak updated to ${msg.version}`);
  });
  ns.teardowns.push(off);
})();
