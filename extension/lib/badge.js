// The toolbar badge (design.md § Toolbar button). Until site access is
// granted the worker can't read tab URLs, so one grey "!" ("action needed")
// shows in every tab. The same "!" shows while the bridge is down (design.md
// § When the bridge or extension is down). Otherwise each tab has its own:
// its page's open tweaks, or the "!" on an unclaimed dev-looking page.
import { matches } from "./match.js";
import { pageOf } from "./tweaks.js";

export const GREY = "#80868b";
// The overlay's status tones (content/overlay.js): blue question, amber
// working, purple sent (sent, delivered and queued alike).
export const URGENT = { question: "#2563d9", working: "#e08a00", sent: "#6d4fd0" };
const TONE = { question: "question", working: "working", sent: "sent", delivered: "sent", queued: "sent" };
const ORDER = ["question", "working", "sent"];

// badge is the global badge, or null to leave it as it is: while a worker's
// first try at the bridge is under way, the badge Chrome kept from before
// the restart is still the best guess. perTab says whether each tab shows
// its own (tabBadge); when false, every tab shows this one.
export function badge({ granted, connection }) {
  if (!granted) return { text: "!", color: GREY, perTab: false };
  if (connection === "connecting") return null;
  const connected = connection === "connected";
  return { text: connected ? "" : "!", color: GREY, perTab: connected };
}

// devLooking says whether a host is one a dev server uses.
const devLooking = (host) =>
  host === "localhost" || host === "127.0.0.1" || host === "lvh.me" || /\.(localhost|test|lvh\.me)$/.test(host);

// tabBadge is one tab's badge while connected with access: url is the tab's,
// claims the bridge's, tweaks the open tweaks by number, before the origins
// claimed before (claimedBefore).
export function tabBadge({ url, claims, tweaks, before = [] }) {
  const none = { text: "", color: GREY };
  let u;
  try {
    u = new URL(url);
  } catch {
    return none;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return none;
  if (claims.some((c) => matches(c.pattern, url))) {
    const page = pageOf(url);
    const open = [...tweaks.values()].filter((t) => t.page === page && TONE[t.status]);
    if (!open.length) return none;
    const tone = ORDER.find((o) => open.some((t) => TONE[t.status] === o));
    return { text: String(open.length), color: URGENT[tone] };
  }
  if (devLooking(u.hostname) || before.some((p) => matches(p, url))) return { text: "!", color: GREY };
  return none;
}

// claimedBefore adds the claims' origins (as whole-site patterns) to the
// list kept in storage.local, returning the same list when none is new.
export function claimedBefore(list, claims) {
  const origins = claims.map((c) => /^[^:]+:\/\/[^/]*/.exec(c.pattern)?.[0]).filter(Boolean).map((o) => `${o}/*`);
  const fresh = [...new Set(origins)].filter((o) => !list.includes(o));
  return fresh.length ? [...list, ...fresh] : list;
}
