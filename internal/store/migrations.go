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
}
