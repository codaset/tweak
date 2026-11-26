// What the overlay says about elements and tweaks: an element's label, its
// visible text and a selector that finds it again; a status as the card and
// pin show it. The status and time parts are pure, and tested in node.
(() => {
  const ns = globalThis.codasetTweak;
  if (!ns || ns.ready) return;

  // How each status reads, and its tone (the pin and dot colour).
  const STATUS = {
    sent: ["Waiting for a session", "sent"],
    delivered: ["Claude has it", "sent"],
    queued: ["Queued", "sent"],
    working: ["Claude is working on it", "working"],
    question: ["Claude has a question", "question"],
    done: ["Change saved", "done"],
    declined: ["Declined", "ended"],
    withdrawn: ["Withdrawn", "ended"],
  };

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
  function status(tweak, now = Date.now()) {
    const [text, tone] = STATUS[tweak.status] ?? [tweak.status, "sent"];
    if (tweak.status === "working" && tweak.statusAt) {
      return { text: `${text} · ${elapsed(now - Date.parse(tweak.statusAt))}`, tone };
    }
    return { text, tone };
  }

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

  ns.describe = { status, elapsed, label, text, selector };
})();
