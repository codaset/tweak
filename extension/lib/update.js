// The self-update decisions (docs/design.md, "The extension updates itself").
// own is this extension's manifest version, bridge the version in the
// bridge's hello reply (none from a development bridge), expected the version
// stored before the last reload, and busy whether any tab is in the middle of
// something (a composer open, pick mode on, an unsent draft).

// decide says what to do about the bridge's version:
// "none", "current", "wait", "reload", or "stuck" (Chrome loads a copy from
// another folder, so reloading doesn't change the version).
export function decide({ own, bridge, expected, busy }) {
  if (!bridge) return "none";
  if (bridge === own) return "current";
  if (expected === bridge) return "stuck";
  return busy ? "wait" : "reload";
}

// justUpdated: this start follows a reload that reached the version expected.
export const justUpdated = ({ own, expected }) => Boolean(expected) && expected === own;
