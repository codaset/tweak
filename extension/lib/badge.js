// The toolbar badge. Until site access is granted the worker can't read tab
// URLs, so one grey "!" ("action needed") shows in every tab. The same "!"
// shows while the bridge is down (design.md § When the bridge or extension
// is down).
export const GREY = "#80868b";

// badge is what the badge shows, or null to leave it as it is: while a
// worker's first try at the bridge is under way, the badge Chrome kept from
// before the restart is still the best guess.
export function badge({ granted, connection }) {
  if (!granted) return { text: "!", color: GREY };
  if (connection === "connecting") return null;
  return { text: connection === "connected" ? "" : "!", color: GREY };
}
