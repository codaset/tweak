// The worker's copy of the open tweaks, rebuilt from the bridge's snapshot
// and moved on by its tweak events (schema/snapshot.json, schema/event.json).
// Every tweak event carries the whole tweak as it now is, so applying one is
// a replace by number.

// pageOf is the page a URL belongs to: origin and path, no query or hash
// (the bridge's store.PageOf, which sets each tweak's page).
export function pageOf(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname || "/"}`;
  } catch {
    return "";
  }
}

// tweaks are the open ones, which pins and cards show; resolved are those
// the developer resolved or withdrew, kept until their deleteAt for the side
// panel's list (with Undo).
const empty = { seq: 0, tweaks: new Map(), resolved: new Map() };
const byNumber = (list = []) => new Map(list.map((t) => [t.number, t]));

// applyTweaks returns the state after one message from the bridge, or the
// same state when the message changes no tweak.
export function applyTweaks(state = empty, msg) {
  if (msg.type === "snapshot") return { seq: msg.seq, tweaks: byNumber(msg.tweaks), resolved: byNumber(msg.resolved) };
  if (msg.type !== "event" || !msg.tweak || msg.seq <= state.seq) return state;
  const tweaks = new Map(state.tweaks);
  const resolved = new Map(state.resolved ?? []);
  const t = msg.tweak;
  if (t.resolvedAt) {
    tweaks.delete(t.number);
    resolved.set(t.number, t);
  } else tweaks.set(t.number, t);
  return { seq: msg.seq, tweaks, resolved };
}

// prune drops the resolved tweaks past their deleteAt at now: the bridge has
// deleted them (without an event), so the worker's copy goes too. It returns
// the same state when none has.
export function prune(state, now = Date.now()) {
  const kept = [...(state.resolved ?? new Map()).values()].filter((t) => !t.deleteAt || Date.parse(t.deleteAt) > now);
  if (kept.length === (state.resolved?.size ?? 0)) return state;
  return { ...state, resolved: byNumber(kept) };
}

// resolvedList is the side panel's list: the resolved tweaks not yet
// deleted at now, newest resolved first.
export const resolvedList = (state, now = Date.now()) =>
  [...(state.resolved ?? new Map()).values()]
    .filter((t) => !t.deleteAt || Date.parse(t.deleteAt) > now)
    .sort((a, b) => Date.parse(b.resolvedAt) - Date.parse(a.resolvedAt) || b.number - a.number);

// forPage lists a page's tweaks, by number.
export const forPage = (state, page) =>
  [...state.tweaks.values()].filter((t) => t.page === page).sort((a, b) => a.number - b.number);

// A tab's card stays open as the tab navigates, so a tab hears about its
// page's tweaks and its open card's, wherever that one's page is. tab is
// {page, card}: the page it shows and the number of its open card, or null.
export const reachesTab = (tweak, tab) => tweak.page === tab.page || tweak.number === tab.card;

// forTab lists what a tab hears about, by number.
export const forTab = (state, tab) =>
  [...state.tweaks.values()].filter((t) => reachesTab(t, tab)).sort((a, b) => a.number - b.number);

// askedIn says where a question Claude has just asked pops up: open in the
// tab the tweak was sent from (whatever page it now shows, since its card
// stays open), or, when that tab is gone, as a toast in every tab showing
// the tweak's page. was and tweak are the tweak before and after an event;
// tabs are {tabId, page}; from is the sending tab's ID, if known.
export function askedIn(was, tweak, tabs, from) {
  if (tweak.status !== "question" || was?.status === "question") return { open: [], toast: [] };
  const open = from === undefined ? [] : tabs.filter((t) => t.tabId === from);
  return { open, toast: open.length ? [] : tabs.filter((t) => t.page === tweak.page) };
}

// askedSince is askedIn for a snapshot: the questions asked while the socket
// was down arrive in it, not as events, so each tweak that has become a
// question since the state before pops up as a live one would. senders maps
// a tweak's number to its sending tab's ID.
export function askedSince(was, next, tabs, senders) {
  const asked = [];
  for (const tweak of [...next.tweaks.values()].sort((a, b) => a.number - b.number)) {
    const { open, toast } = askedIn(was.tweaks.get(tweak.number), tweak, tabs, senders.get(tweak.number));
    if (open.length || toast.length) asked.push({ tweak, open, toast });
  }
  return asked;
}
