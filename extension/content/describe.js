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

  // status is how a tweak's status reads now: while working, with the time
  // since it started (the bridge's statusAt, so a reload keeps the count).
  // No tweak yet is a card still sending.
  function status(tweak, now = Date.now()) {
    if (!tweak) return SENDING;
    const { text, tone } = STATUS[tweak.status] ?? { text: tweak.status, tone: "sent" };
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

  ns.describe = { status, classes, thread, elapsed, label, text, selector, element };
})();
