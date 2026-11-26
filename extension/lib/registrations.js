// Content-script registrations for claims (docs/design.md, "Claims and
// registration"). Pure: the worker passes in what Chrome has registered.

// The isolated-world content script: classic files, run in order, sharing one
// namespace object.
export const CONTENT_FILES = ["content/namespace.js", "content/overlay.js", "content/port.js", "content/toast.js", "content/update.js", "content/boot.js"];
export const PROBE_FILES = ["content/probe.js"];

const PREFIX = "claim-";

// A registration holds one world, so each claim has two: claim-<id> for the
// content script and claim-<id>-probe for the page probe in the page's world.
export function registrationsFor(claim) {
  const common = { matches: [claim.pattern], runAt: "document_start", allFrames: false, persistAcrossSessions: true };
  return [
    { id: `${PREFIX}${claim.id}`, js: CONTENT_FILES, world: "ISOLATED", ...common },
    { id: `${PREFIX}${claim.id}-probe`, js: PROBE_FILES, world: "MAIN", ...common },
  ];
}

const same = (a, b) =>
  a.matches?.length === 1 && a.matches[0] === b.matches[0] && (a.world ?? "ISOLATED") === b.world && a.js?.join() === b.js.join();

// plan compares Chrome's registrations with the claims. It returns the IDs to
// unregister, the registrations to add, and the claims that gained a
// registration (their open tabs need the scripts injected). A registration is
// kept only if its ID, pattern, world and files all still match, since the
// bridge can reuse a released claim's ID.
export function plan(registered, claims) {
  const wanted = new Map(claims.flatMap((c) => registrationsFor(c).map((r) => [r.id, { r, c }])));
  const have = new Map(registered.filter((r) => r.id.startsWith(PREFIX)).map((r) => [r.id, r]));
  const unregister = [];
  for (const [id, r] of have) {
    if (!wanted.has(id) || !same(r, wanted.get(id).r)) unregister.push(id);
  }
  const register = [];
  const added = new Set();
  for (const [id, { r, c }] of wanted) {
    if (have.has(id) && !unregister.includes(id)) continue;
    register.push(r);
    added.add(c);
  }
  return { register, unregister, added: [...added] };
}
