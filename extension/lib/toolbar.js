// What a toolbar click or ⌥⇧C does (design.md § Toolbar button). Decided
// from what the worker already knows, with no await, since the side panel
// must be opened while the gesture lasts:
// - "pick": toggle pick mode in the tab's running scripts;
// - "inject": a claimed page whose scripts aren't running yet (the click's
//   activeTab is the only access there): inject them, then pick;
// - "side-panel": an unclaimed page, one whose URL Chrome doesn't give, or
//   any page while the bridge is down (nothing could be sent).
// url is the tab's (its port's, else the tab's own); claimed(url) says
// whether a claim covers it.
export function toolbar({ down, url, hasScripts, claimed }) {
  if (down || !url || !claimed(url)) return "side-panel";
  return hasScripts ? "pick" : "inject";
}
