// The worker's copy of the claims, rebuilt from the bridge's snapshot and
// moved on by its events (schema/snapshot.json, schema/event.json). Only what
// registration needs is kept: each claim's ID and pattern.

const keep = ({ id, pattern }) => ({ id, pattern });

// apply returns the state after one message from the bridge, or the same
// state when the message changes nothing.
export function apply(state, msg) {
  if (msg.type === "snapshot") return { seq: msg.seq, claims: msg.claims.map(keep) };
  if (msg.type !== "event" || msg.seq <= state.seq) return state;
  const others = state.claims.filter((c) => c.id !== msg.claim.id);
  switch (msg.event) {
    case "claim-made":
      return { seq: msg.seq, claims: [...others, keep(msg.claim)] };
    case "claim-released":
      return { seq: msg.seq, claims: others };
    default:
      return { ...state, seq: msg.seq };
  }
}
