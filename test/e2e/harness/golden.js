// Checks a brief against a fixture's golden case (design.md § Golden data).
// It matches tokens, not layout: the brief's layout is golden-tested in Go.

// The words that stand for a role or a mapper in a "Where to look" line.
// The brief may word a role as what it does ("renders elements 1 and 2").
const WORDS = {
  element: ["element"],
  component: ["component", "renders", "template"],
  usage: ["usage", "used"],
  style: ["style", "rule"],
};

const hasWord = (line, token) => (WORDS[token] ?? [token]).some((w) => new RegExp(`\\b${w}\\b`, "i").test(line));

// The bullet lines of the brief's "Where to look" section, in order.
export function whereToLook(brief) {
  const lines = brief.split("\n");
  const start = lines.findIndex((l) => /^##\s+Where to look\s*$/i.test(l));
  if (start < 0) return [];
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    if (/^\s*[-*]\s/.test(line)) out.push(line);
  }
  return out;
}

// Backticks and double quotes dropped, so `data-testid="save"` and the
// case's data-testid=save compare equal.
const plain = (s) => s.replace(/[`"]/g, "").replace(/\s+/g, " ").toLowerCase();

// What's wrong with the brief, as a list of sentences; empty when it matches.
// The listed locations must be the first N under "Where to look", in order;
// the listed clues must all be present.
export function briefProblems(brief, { locations = [], clues = [] }) {
  const problems = [];
  const listed = whereToLook(brief);
  locations.forEach((loc, i) => {
    const line = listed[i];
    const where = loc.line === undefined ? loc.file : `${loc.file}:${loc.line}`;
    const want = `\`${where}\` (${loc.role}, ${loc.via})`;
    if (!line) return problems.push(`location ${i + 1}, ${want}, isn't listed: "Where to look" has ${listed.length}`);
    const at = line.indexOf(`\`${where}`);
    const next = line[at + where.length + 1];
    // A file-only location must be listed without a line.
    const placed = at >= 0 && (next === "`" || (loc.line !== undefined && next === ":"));
    if (!placed) problems.push(`location ${i + 1} should be ${want}, not: ${line.trim()}`);
    else if (!hasWord(line, loc.role) || !hasWord(line, loc.via)) problems.push(`location ${i + 1} should say ${loc.role} and ${loc.via}: ${line.trim()}`);
  });
  const text = plain(brief);
  for (const clue of clues) {
    // Whole clues only: data-testid=save isn't data-testid=save-user.
    const at = new RegExp(`(?<![\\w-])${RegExp.escape(plain(clue))}(?![\\w-])`);
    if (!at.test(text)) problems.push(`clue ${clue} is missing`);
  }
  return problems;
}
