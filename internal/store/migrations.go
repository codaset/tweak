package store

// migrations are the schema's steps, in order. Never edit or reorder a step
// that has shipped: add a new one. Each runs in one transaction. Times are
// Unix milliseconds.
var migrations = []string{
	// 1: the data model from docs/design.md, "Bridge contract".
	`
CREATE TABLE sessions (
	id            TEXT PRIMARY KEY,
	agent         TEXT NOT NULL,
	folder        TEXT NOT NULL,
	label         TEXT NOT NULL DEFAULT '',
	last_check_in INTEGER NOT NULL
);
CREATE TABLE claims (
	id      INTEGER PRIMARY KEY,
	session TEXT NOT NULL REFERENCES sessions (id),
	pattern TEXT NOT NULL,
	created INTEGER NOT NULL
);
CREATE INDEX claims_session ON claims (session);
CREATE TABLE tweaks (
	number          INTEGER PRIMARY KEY,
	session         TEXT REFERENCES sessions (id),
	page_url        TEXT NOT NULL,
	status          TEXT NOT NULL,
	resolved_at     INTEGER,
	created         INTEGER NOT NULL,
	updated         INTEGER NOT NULL,
	targets         TEXT NOT NULL,
	click_anchor    TEXT,
	screenshot_path TEXT
);
CREATE TABLE entries (
	id     INTEGER PRIMARY KEY,
	tweak  INTEGER NOT NULL REFERENCES tweaks (number),
	"from" TEXT NOT NULL,
	kind   TEXT NOT NULL,
	text   TEXT NOT NULL,
	at     INTEGER NOT NULL
);
CREATE INDEX entries_tweak ON entries (tweak);
CREATE TABLE changes (
	id               INTEGER PRIMARY KEY,
	tweak            INTEGER NOT NULL REFERENCES tweaks (number),
	state            TEXT NOT NULL,
	unrecorded_files TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE change_files (
	id     INTEGER PRIMARY KEY,
	change INTEGER NOT NULL REFERENCES changes (id),
	path   TEXT NOT NULL,
	before BLOB,
	after  BLOB
);
CREATE TABLE events (
	seq     INTEGER PRIMARY KEY AUTOINCREMENT,
	type    TEXT NOT NULL,
	tweak   INTEGER,
	claim   INTEGER,
	payload TEXT NOT NULL DEFAULT '{}',
	at      INTEGER NOT NULL
);
CREATE TABLE deliveries (
	session  TEXT PRIMARY KEY REFERENCES sessions (id),
	last_ack INTEGER NOT NULL DEFAULT 0
);
`,
	// 2: tweaks for the tracer. The table is rebuilt (it has never held a
	// row) so numbers use AUTOINCREMENT and are never reused; page is the
	// origin and path a tweak belongs to, page_url the full URL it was sent
	// from, status_at when the status last changed. Each session's inbox
	// cursor starts at the end of the log.
	`
CREATE TABLE tweaks_v2 (
	number          INTEGER PRIMARY KEY AUTOINCREMENT,
	session         TEXT REFERENCES sessions (id),
	page            TEXT NOT NULL,
	page_url        TEXT NOT NULL,
	status          TEXT NOT NULL,
	status_at       INTEGER NOT NULL,
	resolved_at     INTEGER,
	created         INTEGER NOT NULL,
	updated         INTEGER NOT NULL,
	targets         TEXT NOT NULL,
	click_anchor    TEXT,
	screenshot_path TEXT
);
INSERT INTO tweaks_v2 (number, session, page, page_url, status, status_at, resolved_at, created, updated, targets, click_anchor, screenshot_path)
	SELECT number, session, page_url, page_url, status, updated, resolved_at, created, updated, targets, click_anchor, screenshot_path FROM tweaks;
DROP TABLE tweaks;
ALTER TABLE tweaks_v2 RENAME TO tweaks;
CREATE INDEX tweaks_page ON tweaks (page);
CREATE INDEX tweaks_session ON tweaks (session);
INSERT OR IGNORE INTO deliveries (session, last_ack)
	SELECT id, (SELECT coalesce(max(seq), 0) FROM events) FROM sessions;
`,
	// 3: "No lost tweaks". resends counts the again: lines sent for a
	// delivered tweak; wait_from is when its wait for Claude to confirm it
	// began (its line's ack), and is null while an again: line is waiting
	// to be printed. Tweaks already delivered wait from when they were.
	`
ALTER TABLE tweaks ADD COLUMN resends INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tweaks ADD COLUMN wait_from INTEGER;
UPDATE tweaks SET wait_from = status_at WHERE status = 'delivered';
`,
	// 4: undo capture. A tweak has one change. capturing is the session
	// whose edits it records, while it does (one change per session);
	// folder is that session's project; repo and base_tree are the git
	// check's working tree from tweak work ('' outside a repo); checked says
	// the last check ran. A file is recorded once per change, the first
	// time it's touched; shown is its path as the card lists it (project-
	// relative, or absolute outside the project); recordable is 0 for a
	// binary or oversized file, which counts as unrecorded; base_tree is the
	// git snapshot of the round it was recorded in, which its before copy
	// is checked against.
	`
CREATE UNIQUE INDEX changes_tweak ON changes (tweak);
ALTER TABLE changes ADD COLUMN capturing TEXT REFERENCES sessions (id);
ALTER TABLE changes ADD COLUMN folder TEXT NOT NULL DEFAULT '';
ALTER TABLE changes ADD COLUMN repo TEXT NOT NULL DEFAULT '';
ALTER TABLE changes ADD COLUMN base_tree TEXT NOT NULL DEFAULT '';
ALTER TABLE changes ADD COLUMN checked INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX changes_capturing ON changes (capturing);
CREATE UNIQUE INDEX change_files_path ON change_files (change, path);
ALTER TABLE change_files ADD COLUMN shown TEXT NOT NULL DEFAULT '';
ALTER TABLE change_files ADD COLUMN outside INTEGER NOT NULL DEFAULT 0;
ALTER TABLE change_files ADD COLUMN recordable INTEGER NOT NULL DEFAULT 1;
ALTER TABLE change_files ADD COLUMN base_tree TEXT NOT NULL DEFAULT '';
`,
	// 5: reversing a change. conflicts is how many of an undo-requested
	// change's files couldn't be reversed around later edits: the
	// undo-conflict line says so.
	`
ALTER TABLE changes ADD COLUMN conflicts INTEGER NOT NULL DEFAULT 0;
`,
	// 6: claims when sessions end, lapse or come back. A lapsed claim is
	// kept for 24 hours in lapsed_claims; lost_to is the folder of the
	// session that claimed an overlapping pattern since (it can't come
	// back), and reported says its session has been told. A tweak whose
	// session let go of its page has no session; left_by is that session,
	// left_why how it let go (lapsed, released or ended), left_status and
	// left_status_at its status then, and left_capturing whether it was
	// capturing, so a lapsed claim's tweaks come back as they were. line is
	// what its session's last inbox line for it was: new, or reply.
	`
CREATE TABLE lapsed_claims (
	id        INTEGER PRIMARY KEY AUTOINCREMENT,
	session   TEXT NOT NULL REFERENCES sessions (id),
	pattern   TEXT NOT NULL,
	created   INTEGER NOT NULL,
	lapsed_at INTEGER NOT NULL,
	lost_to   TEXT,
	reported  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX lapsed_claims_session ON lapsed_claims (session);
ALTER TABLE tweaks ADD COLUMN left_by TEXT REFERENCES sessions (id);
ALTER TABLE tweaks ADD COLUMN left_why TEXT;
ALTER TABLE tweaks ADD COLUMN left_status TEXT;
ALTER TABLE tweaks ADD COLUMN left_status_at INTEGER;
ALTER TABLE tweaks ADD COLUMN left_capturing INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tweaks ADD COLUMN line TEXT NOT NULL DEFAULT 'new';
UPDATE tweaks SET line = 'reply' WHERE EXISTS (SELECT 1 FROM entries e WHERE e.tweak = tweaks.number AND e.kind = 'reply');
`,
}
