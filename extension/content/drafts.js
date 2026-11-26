// This tab's drafts (design.md § Where state lives): the composer's and each
// card's reply, saved as you type, handed back when the page loads again,
// and cleared on Send or esc. A content script doesn't know its tab's ID, so
// the worker keeps them, per tab in storage.session, as it keeps the open
// card. The card fills them in and restores them (card.js).
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  // compose: {page, kind, selectors, anchor, selection?, whole?, area?,
  // text}, or null; replies: {[number]: {text, question}}, question being
  // which of the tweak's questions it answers (1 for the first).
  let compose = null;
  const replies = {};
  let adopted = false; // until the kept drafts are back, saving would overwrite them

  const save = () => {
    if (!adopted) return;
    const kept = compose || Object.keys(replies).length ? { compose, replies } : null;
    ns.worker.post({ type: "draft", draft: kept });
  };

  ns.drafts = {
    compose: () => compose,
    // reply is the draft answer to a tweak's question, or "" when the one
    // kept answers an earlier question.
    reply: (number, question) => (replies[number]?.question === question ? replies[number].text : ""),
    // setCompose keeps the composer's draft, or drops it (null, or no text).
    setCompose(draft) {
      const next = draft?.text?.trim() ? draft : null;
      if (next === null && compose === null) return;
      compose = next;
      save();
    },
    setReply(number, text, question) {
      if (!text.trim()) {
        if (!(number in replies)) return;
        delete replies[number];
      } else replies[number] = { text, question };
      save();
    },
    // adopt takes what the worker handed back on load. Text typed since
    // (the page was quicker) wins.
    adopt(draft) {
      adopted = true;
      compose ??= draft?.compose ?? null;
      for (const [n, reply] of Object.entries(draft?.replies ?? {})) replies[n] ??= reply;
      save();
    },
  };

  // A post while the worker's port is gone goes nowhere, so the drafts are
  // saved again once it's back (a state message follows every connect).
  const off = ns.worker.on((msg) => {
    if (msg.type === "state") save();
  });
  ns.teardowns.push(off);
})();
