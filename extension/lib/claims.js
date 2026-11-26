// The worker's copy of the claims, rebuilt from the bridge's snapshot and
// moved on by its events (schema/snapshot.json, schema/event.json): the held
// claims, with what registration needs (ID and pattern) and what the card
// says about their session (its folder, and whether it's listening); and the
// lapsed claims that can still come back to their session, which the side
// panel names (docs/design.md § When the session goes quiet).
import { matches } from "./match.js";

const keep = ({ id, pattern, session, listening }) => ({
  id,
  pattern,
  session: session?.id ?? "",
  folder: session?.folder ?? "",
  listening: listening !== false, // a cached claim says nothing: listening
});
const keepLapsed = ({ pattern, session, lapsedAt }) => ({
  pattern,
  session: session?.id ?? "",
  folder: session?.folder ?? "",
  lapsedAt: lapsedAt ?? "",
});
// A lapsed claim comes back under a new ID, so it's known by its session
// and pattern.
const sameLapse = (a, b) => a.session === b.session && a.pattern === b.pattern;

const empty = { seq: 0, claims: [], lapsed: [] };

// RESTORE_FOR is how long a lapsed claim can come back to its session
// (the bridge forgets it then, saying nothing).
export const RESTORE_FOR = 24 * 60 * 60_000;

// coverOf says what covers a URL: a held claim ("claimed"), a lapsed claim
// that can still come back ("lapsed", with its session's folder, its
// pattern and when it lapsed), or nothing ("none"). A lapsed page counts as
// unclaimed, but keeps its pins and cards.
export function coverOf(state, url, now = Date.now()) {
  if (state.claims.some((c) => matches(c.pattern, url))) return { kind: "claimed" };
  const l = restorable(state, now).find((l) => matches(l.pattern, url));
  return l ? { kind: "lapsed", folder: l.folder, pattern: l.pattern, lapsedAt: l.lapsedAt } : { kind: "none" };
}

const restorable = (state, now) => (state.lapsed ?? []).filter((l) => now < Date.parse(l.lapsedAt) + RESTORE_FOR);

// registered is what gets the content scripts: the held claims, and the
// lapsed ones that can still come back, under IDs of their own (a lapsed
// claim is known by its session and pattern).
export function registered(state, now = Date.now()) {
  return [...state.claims.map(({ id, pattern }) => ({ id, pattern })), ...restorable(state, now).map((l) => ({ id: `lapsed-${hash(`${l.session} ${l.pattern}`)}`, pattern: l.pattern }))];
}

// ago is how long since a time, as the side panel says it: "just now",
// "3 min ago", "2 h ago".
export function ago(at, now = Date.now()) {
  const m = Math.floor(Math.max(0, now - Date.parse(at)) / 60_000);
  if (m < 1) return "just now";
  return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
}

// hash is FNV-1a, in hex: a short, stable name for a string.
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

// heldBy is the session holding a tweak's page, as its card names it: its
// folder, and whether it's listening; or null when no session holds it.
// The tweak's own URL counts, not the tab's: a card follows its tab.
export function heldBy(state, tweak) {
  const c = state.claims.find((c) => matches(c.pattern, tweak.url));
  return c ? { folder: c.folder, listening: c.listening } : null;
}

// apply returns the state after one message from the bridge, or the same
// state when the message changes nothing.
export function apply(state = empty, msg) {
  if (msg.type === "snapshot") return { seq: msg.seq, claims: msg.claims.map(keep), lapsed: (msg.lapsed ?? []).map(keepLapsed) };
  if (msg.type !== "event" || !msg.claim || msg.seq <= state.seq) return state;
  const others = state.claims.filter((c) => c.id !== msg.claim.id);
  const lapse = keepLapsed(msg.claim);
  const lapsed = (state.lapsed ?? []).filter((l) => !sameLapse(l, lapse));
  switch (msg.event) {
    case "claim-made":
      return { ...state, seq: msg.seq, claims: [...others, keep(msg.claim)] };
    case "claim-listening": // its session's watcher went, or came back
      return { ...state, seq: msg.seq, claims: state.claims.map((c) => (c.id === msg.claim.id ? keep(msg.claim) : c)) };
    case "claim-restored": // a lapsed claim back with its session
      return { seq: msg.seq, claims: [...others, keep(msg.claim)], lapsed };
    case "claim-released":
      return { ...state, seq: msg.seq, claims: others };
    case "claim-lapsed": // its session stopped responding: the page is unclaimed
      return { seq: msg.seq, claims: others, lapsed: [...lapsed, lapse] };
    case "claim-lost": // another session claimed over it: it can't come back
      return { ...state, seq: msg.seq, lapsed };
    default:
      return { ...state, seq: msg.seq };
  }
}
