// This tab's drafts (design.md § Where state lives): the composer's and each
// card's reply, saved as you type, handed back when the page loads again,
// and cleared on Send or esc. A content script doesn't know its tab's ID, so
// the worker keeps them, per tab in storage.session, as it keeps the open
// card. The card fills them in and restores them (card.js).
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  // compose: {page, kind, selectors, anchor, selection?, area?, text}, or
  // null; replies: {[number]: text}.
  let compose = null;
  const replies = {};

  const save = () => {
    const kept = compose || Object.keys(replies).length ? { compose, replies } : null;
    ns.worker.post({ type: "draft", draft: kept });
  };

  ns.drafts = {
    compose: () => compose,
    reply: (number) => replies[number] ?? "",
    // setCompose keeps the composer's draft, or drops it (null, or no text).
    setCompose(draft) {
      const next = draft?.text?.trim() ? draft : null;
      if (next === null && compose === null) return;
      compose = next;
      save();
    },
    setReply(number, text) {
      if (!text.trim()) {
        if (!(number in replies)) return;
        delete replies[number];
      } else replies[number] = text;
      save();
    },
    // adopt takes what the worker handed back on load. Text typed since
    // (the page was quicker) wins.
    adopt(draft) {
      compose ??= draft?.compose ?? null;
      for (const [n, text] of Object.entries(draft?.replies ?? {})) replies[n] ??= text;
    },
  };
})();
