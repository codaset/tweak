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
  // How sent and delivered read once the developer has replied to a question.
  const REPLIED = { sent: "Reply sent", delivered: "Claude has your reply" };
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
    undo: "Undo",
    notice: "Tweak",
  };
  const ANNOUNCED = { you: false, claude: true, bridge: true }; // your own words aren't read back
  // SENDING is a card's tweak that the bridge hasn't sent back yet.
  const SENDING = { text: "Sending…", tone: "sent" };

  // elapsed is a duration as the card shows it: 12 s, 6 min, 1 h 5 min.
  function elapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min`;
    return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 60)} h`;
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
  function status(tweak, now = Date.now()) {
    if (!tweak) return SENDING;
    const { text, tone } = STATUS[tweak.status] ?? { text: tweak.status, tone: "sent" };
    if (unanswered(tweak, now)) return { text: UNANSWERED, tone };
    // A reply sends the tweak again: it waits for the same session, not a new one.
    if (tweak.entries?.at(-1)?.kind === "reply" && REPLIED[tweak.status]) return { text: REPLIED[tweak.status], tone };
    if (tweak.status === "working" && tweak.statusAt) {
      return { text: `${text} · ${elapsed(now - Date.parse(tweak.statusAt))}`, tone };
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
      const label = ENTRY[e.kind] ?? e.kind;
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
  function change(tweak) {
    const c = tweak?.change;
    if (!c || (tweak.status !== "done" && tweak.status !== "declined")) return null;
    const files = c.files ?? [];
    const unrecorded = c.unrecorded ?? [];
    if (files.length) return { kind: "recorded", title: "Files changed", files, unrecorded };
    if (unrecorded.length || !c.checked) return { kind: "nothing-recorded", title: "No edits recorded", files, unrecorded };
    if (tweak.status === "declined") return null; // declined before changing anything: nothing to say
    return { kind: "unchanged", title: "No files changed", files, unrecorded };
  }
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

  ns.describe = { status, unanswered, resendOffer, classes, thread, change, UNRECORDED, OUTSIDE, elapsed, label, text, selector, element };
})();
