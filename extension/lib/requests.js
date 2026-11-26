// Requests to the bridge that it answers with a result carrying the same ref
// (schema/result.json). Each waiting request has a reply function; one that
// throws (its tab went away) never stops the others or the caller.

export function requests() {
  const pending = new Map();
  let n = 0;
  const call = (reply, answer) => {
    try {
      reply(answer);
    } catch {
      // The tab is gone; nothing to tell.
    }
  };
  return {
    // add keeps reply until the result for the returned ref arrives.
    add(reply) {
      const ref = `w${++n}`;
      pending.set(ref, reply);
      return ref;
    },
    answer(msg) {
      const reply = pending.get(msg.ref);
      if (!reply) return;
      pending.delete(msg.ref);
      call(reply, msg.number ? { number: msg.number } : { error: msg.message });
    },
    forget(ref) {
      pending.delete(ref);
    },
    // dropAll ends every waiting request with error, as when the socket closes.
    dropAll(error) {
      const replies = [...pending.values()];
      pending.clear();
      for (const reply of replies) call(reply, { error });
    },
  };
}
