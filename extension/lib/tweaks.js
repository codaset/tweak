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

const empty = { seq: 0, tweaks: new Map() };

// applyTweaks returns the state after one message from the bridge, or the
// same state when the message changes no tweak.
export function applyTweaks(state = empty, msg) {
  if (msg.type === "snapshot") return { seq: msg.seq, tweaks: new Map(msg.tweaks.map((t) => [t.number, t])) };
  if (msg.type !== "event" || !msg.tweak || msg.seq <= state.seq) return state;
  const tweaks = new Map(state.tweaks);
  tweaks.set(msg.tweak.number, msg.tweak);
  return { seq: msg.seq, tweaks };
}

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
