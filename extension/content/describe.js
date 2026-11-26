// What the overlay says about elements and tweaks: an element's label, its
// visible text and a selector that finds it again; a status as the card and
// pin show it. The status and time parts are pure, and tested in node.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  // How each status reads, and its tone (the pin and dot colour).
  const STATUS = {
    sent: { text: "Waiting for a session", tone: "sent" },
    delivered: { text: "Claude has it", tone: "sent" },
    queued: { text: "Queued", tone: "sent" },
    working: { text: "Claude is working on it", tone: "working" },
    question: { text: "Claude has a question", tone: "question" },
    done: { text: "Change saved", tone: "done" },
    declined: { text: "Declined", tone: "ended" },
    withdrawn: { text: "Withdrawn", tone: "ended" },
  };
  // The status sets, the one place each is named:
  // - OPEN: Claude is still on it, so it can be withdrawn;
  // - ENDED_BY_CLAUDE: Claude has finished with it, done or declined, so it
  //   can be resolved;
  // - FINAL: its change is final, Claude's end or the developer's withdrawal.
  const OPEN = new Set(["sent", "delivered", "queued", "working", "question"]);
  const ENDED_BY_CLAUDE = new Set(["done", "declined"]);
  const FINAL = new Set([...ENDED_BY_CLAUDE, "withdrawn"]);
  // How sent and delivered read once the developer has replied to a question.
  const REPLIED = { sent: "Reply sent", delivered: "Claude has your reply" };
  // WITH_CLAUDE: the statuses that say Claude has the tweak; the card shows
  // Claude's spark for them instead of the status dot.
  const WITH_CLAUDE = new Set(["delivered", "working", "question"]);
  // The statuses that wait on the session to hear of the tweak: these need
  // its watcher.
  const WAITS = { sent: true, delivered: true };
  const LAPSED = "The session stopped responding";
  // The conversation's vocabulary (schema/event.json's entry kinds and
  // senders), the one place the card reads it from: how each kind is
  // labelled, and whether a sender's new entries are read out. A new kind
  // needs only a line here, and a .kind-<kind> rule if it looks different.
  const ENTRY = {
    request: "You",
    plan: "Claude's plan",
    question: "Claude asks",
    reply: "You replied",
    summary: "Claude",
    reason: "Why Claude declined",
    undo: { you: "You undid it", claude: "Claude undid it" },
    notice: "Tweak",
  };
  const ANNOUNCED = { you: false, claude: true, bridge: true }; // your own words aren't read back
  // SENDING is a card's tweak that the bridge hasn't sent back yet.
  const SENDING = { text: "Sending…", tone: "sent" };

  // span is a length of time as Tweak says it everywhere (the CLI's
  // "last seen" too): its largest whole unit, "12 s", "6 min", "5 h", then
  // "3 days" from 2 days on. A time gone by rounds down; round is Math.ceil
  // for a time left, so it never says less than there is.
  function span(ms, round = Math.floor) {
    const units = [[1000, 60, "s"], [60_000, 60, "min"], [3_600_000, 48, "h"]];
    const t = Math.max(0, ms);
    for (const [size, below, unit] of units) {
      const n = round(t / size);
      if (n < below) return `${n} ${unit}`;
    }
    return `${round(t / 86_400_000)} days`;
  }

  // ago is how long since a time, as the side panel says it: "just now",
  // "3 min ago", "2 h ago".
  function ago(at, now = Date.now()) {
    const ms = now - Date.parse(at);
    return ms < 60_000 ? "just now" : `${span(ms)} ago`;
  }

  // unanswered says whether Claude hasn't picked up a delivered tweak: the
  // bridge has sent it again twice (or Send again has, since) and the wait
  // for the last one is over. The bridge sends againAt, when the wait ends,
  // only while no again: line is on its way (design.md § No lost tweaks).
  const UNANSWERED = "Claude hasn't picked this up. The session may be busy.";
  const unanswered = (tweak, now = Date.now()) =>
    tweak?.status === "delivered" && (tweak.resends ?? 0) >= 2 && Boolean(tweak.againAt) && now >= Date.parse(tweak.againAt);

  // resendOffer says whether the card offers Send again. sentAt is the
  // tweak's resends when a Send again was answered, or undefined: the offer
  // hides until the tweak's resend shows (its event may come after the
  // answer), then the hold ends, so a later delivery's offer isn't hidden.
  // It returns the offer and the sentAt to keep.
  function resendOffer(tweak, sentAt, now = Date.now()) {
    const held = sentAt !== undefined && tweak?.resends === sentAt;
    return { offer: unanswered(tweak, now) && !held, sentAt: held ? sentAt : undefined };
  }

  // status is how a tweak's status reads now: while working, with the time
  // since it started (the bridge's statusAt, so a reload keeps the count).
  // No tweak yet is a card still sending.
  // While the session goes quiet (design.md § When the session goes quiet),
  // a tweak waiting on it says so: its watcher is gone (heldBy, from the
  // worker), or its claim lapsed (left, from the bridge). code is the part
  // of text the card shows as code.
  function status(tweak, now = Date.now()) {
    if (!tweak) return SENDING;
    const { text, tone } = STATUS[tweak.status] ?? { text: tweak.status, tone: "sent" };
    if (tweak.status === "sent" && tweak.left?.why === "lapsed") return { text: `${LAPSED} · ${text}`, tone, quiet: true };
    if (WAITS[tweak.status] && tweak.heldBy?.listening === false) {
      const folder = tweak.heldBy.folder;
      return { text: `Waiting for the session in ${folder}, which isn't listening right now`, tone, quiet: true, code: folder };
    }
    if (unanswered(tweak, now)) return { text: UNANSWERED, tone };
    // A reply sends the tweak again: it waits for the same session, not a new one.
    if (tweak.entries?.at(-1)?.kind === "reply" && REPLIED[tweak.status]) return { text: REPLIED[tweak.status], tone };
    if (tweak.status === "working" && tweak.statusAt) {
      return { text: `${text} · ${span(now - Date.parse(tweak.statusAt))}`, tone };
    }
    return { text, tone };
  }

  // classes are the status modifier classes a pin and the card's status
  // share: the tone, and working (the pulse).
  // thread is the conversation the card shows below the request: every
  // later entry, labelled, oldest first.
  // Each entry has its label, the classes the card styles it by, and what a
  // screen reader hears when it arrives ("" for none).
  const thread = (tweak) =>
    (tweak?.entries ?? []).slice(1).map((e) => {
      const named = ENTRY[e.kind] ?? e.kind;
      const label = typeof named === "string" ? named : (named[e.from] ?? e.kind);
      return {
        kind: e.kind,
        from: e.from,
        label,
        text: e.text,
        className: `entry kind-${e.kind} from-${e.from}`,
        announce: ANNOUNCED[e.from] ? `${label}: ${e.text}` : "",
      };
    });

  // change is what a finished tweak's card says it changed (design.md § On
  // the card), or null for nothing to say: shown once Claude is done, or has
  // declined after changing something; never while it works or asks. Each
  // list is files as {path, outside}.
  // - title "Files changed", with the recorded files; unrecorded is the
  //   "Also changed while Claude worked, not recorded" list;
  // - "No edits recorded": something changed, or there's no repo to check,
  //   but no edit was recorded;
  // - "No files changed": the git check ran and found nothing.
  // announce is what a screen reader hears when it appears.
  // - "Files already changed": no session has the tweak (its claim lapsed,
  //   say) part-way through, and these files changed meanwhile; no Undo,
  //   as the tweak isn't finished.
  function change(tweak) {
    const c = described(tweak) ?? partial(tweak);
    if (!c) return null;
    const count = (n, what) => `${n} ${what}${n === 1 ? "" : "s"}`;
    const announce = c.files.length
      ? count(c.files.length, "file") + " changed" + (c.unrecorded.length ? `, ${c.unrecorded.length} not recorded` : "")
      : c.title;
    return { ...c, announce };
  }
  function described(tweak) {
    const c = tweak?.change;
    if (!c || !FINAL.has(tweak.status)) return null;
    const files = c.files ?? [];
    const unrecorded = c.unrecorded ?? [];
    if (files.length) return { kind: "recorded", title: "Files changed", files, unrecorded };
    if (unrecorded.length || !c.checked) return { kind: "nothing-recorded", title: "No edits recorded", files, unrecorded };
    if (tweak.status !== "done") return null; // declined or withdrawn before changing anything: nothing to say
    return { kind: "unchanged", title: "No files changed", files, unrecorded };
  }
  function partial(tweak) {
    const c = tweak?.change;
    if (!c || !tweak.left || tweak.status !== "sent") return null;
    const files = c.files ?? [];
    const unrecorded = c.unrecorded ?? [];
    return files.length || unrecorded.length ? { kind: "partial", title: "Files already changed", files, unrecorded } : null;
  }
  // undo is what the card offers to undo a finished change, or where its
  // undo is (design.md § On the card), or null for nothing:
  // - offer: a button labelled Undo (every edit recorded; note says when
  //   only the recorded files revert), or Ask Claude to undo (nothing
  //   recorded, but something changed);
  // - asked: the undo is with Claude, which reverses it by hand;
  // - waiting: it is, but no session claims the page: text, then command
  //   to copy, the claim that would take it;
  // - undone.
  // Never while Claude works or asks, and never for no files changed.
  function undo(tweak) {
    const c = described(tweak);
    if (!c) return null;
    const state = tweak.change.state;
    if (state === "undone") return { kind: "undone", text: "Undone" };
    if (state === "undo-requested") {
      if (tweak.change.waiting) return { kind: "waiting", text: "Needs a session to resolve: run", command: `/tweak ${origin(tweak.url)}` };
      const why = c.files.length ? `${tweak.change.conflicts ?? 0} of ${c.files.length} files changed since` : "no edits were recorded";
      return { kind: "asked", text: `Undo needs Claude: ${why}` };
    }
    if (c.kind === "recorded") return { kind: "offer", label: "Undo", note: c.unrecorded.length ? "Undo reverts only the recorded files." : "" };
    if (c.kind === "nothing-recorded") return { kind: "offer", label: "Ask Claude to undo", note: "" };
    return null;
  }
  // finish is how the card lets the developer finish with a tweak, or null:
  // Withdraw while it's open (before Claude finishes), Resolve once Claude
  // is done or has declined; neither once it's resolved.
  function finish(tweak) {
    if (!tweak || tweak.resolvedAt) return null;
    if (OPEN.has(tweak.status)) return { kind: "withdraw", label: "Stop and withdraw" };
    if (ENDED_BY_CLAUDE.has(tweak.status)) return { kind: "resolve", label: "Resolve" };
    return null;
  }
  // kept is how long a resolved tweak, and its Undo, stays: "Kept for 6
  // days", or "" once it's due to go. At least a minute: the side panel
  // draws it again a minute at a time.
  function kept(tweak, now = Date.now()) {
    const left = Date.parse(tweak?.deleteAt) - now;
    return left > 0 ? `Kept for ${span(Math.max(left, 60_000), Math.ceil)}` : "";
  }
  // origin is a page URL's scheme, host and port: what /tweak claims.
  const origin = (url = "") => url.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i)?.[0] ?? url;
  const UNRECORDED = "Also changed while Claude worked, not recorded:";
  const OUTSIDE = "outside this project";

  const classes = (tweak) => `tone-${status(tweak).tone}${tweak?.status === "working" ? " working" : ""}`;

  // label is the tag plus an ID or up to two classes: button.btn-primary.
  function label(el) {
    const tag = el.localName;
    if (el.id) return `${tag}#${el.id}`;
    const classes = [...el.classList].filter((c) => !/[:[\]]/.test(c)).slice(0, 2);
    return classes.length ? `${tag}.${classes.join(".")}` : tag;
  }

  // text is the element's own visible text, first line, at most 80 characters.
  function text(el) {
    const first = (el.innerText ?? el.textContent ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
    return first.length > 80 ? `${first.slice(0, 79)}…` : first;
  }

  // selector finds el again: an ID if it's unique, else a path of
  // nth-of-type steps up to the nearest ancestor with a unique ID.
  function selector(el) {
    const unique = (sel) => {
      try {
        return document.querySelectorAll(sel).length === 1;
      } catch {
        return false;
      }
    };
    const steps = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (node.id && unique(`#${CSS.escape(node.id)}`)) {
        steps.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      if (node === document.documentElement) {
        steps.unshift("html");
        break;
      }
      const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.localName === node.localName) : [];
      steps.unshift(same.length > 1 ? `${node.localName}:nth-of-type(${same.indexOf(node) + 1})` : node.localName);
    }
    return steps.join(" > ");
  }

  // element is one element as a tweak's targets carry it (schema/create.json).
  const element = (el) => ({ label: label(el), text: text(el), selector: selector(el) });

  // pointedAt is what a tweak's targets point at, as the composer's chip says
  // it: element 1's label, "3 elements", the selected text quoted, or the
  // area's size.
  function pointedAt(targets) {
    const els = targets?.elements ?? [];
    if (targets?.area) return `Area ${Math.round(targets.area.page.width)}×${Math.round(targets.area.page.height)}`;
    if (targets?.selection) {
      const s = [...targets.selection.text.replace(/\s+/g, " ").trim()];
      return `“${s.length > 24 ? `${s.slice(0, 23).join("")}…` : s.join("")}”`;
    }
    if (els.length > 1) return `${els.length} elements`;
    return els[0]?.label ?? "";
  }

  ns.describe = { status, unanswered, resendOffer, classes, thread, change, undo, finish, kept, span, ago, origin, OPEN, ENDED_BY_CLAUDE, WITH_CLAUDE, FINAL, UNRECORDED, OUTSIDE, label, text, selector, element, pointedAt };
})();
