// Package store is the bridge's SQLite database: the data model from
// docs/design.md, its migrations, and the queries the bridge runs.
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite" // the pure-Go driver, registered as "sqlite"
)

// Store is an open database.
type Store struct {
	db *sql.DB
}

// Open opens (creating if needed) the database at path and brings it up to
// date. version is this binary's Tweak version, recorded with the schema so a
// refusal can name both.
func Open(path, version string) (*Store, error) {
	return openWith(path, version, migrations)
}

func openWith(path, version string, steps []string) (*Store, error) {
	dsn := "file:" + (&url.URL{Path: path}).EscapedPath() +
		"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// One connection: SQLite serialises writes anyway, and it keeps the
	// per-connection pragmas in one place.
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	if err := s.migrate(path, version, steps); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

// migrate runs each pending step in its own transaction, which also records
// the schema version (SQLite's user_version) and the Tweak version that wrote
// it. An existing database is backed up first, keeping only that copy.
func (s *Store) migrate(path, version string, steps []string) error {
	var current int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&current); err != nil {
		return fmt.Errorf("can't read %s: %w", path, err)
	}
	if current > len(steps) {
		return fmt.Errorf("database is from Tweak %s; this is %s", s.writtenBy(), version)
	}
	if current == len(steps) {
		return nil
	}
	if current > 0 {
		if err := s.backup(path, s.writtenBy()); err != nil {
			return err
		}
	}
	for n := current + 1; n <= len(steps); n++ {
		if err := s.step(n, steps[n-1], version); err != nil {
			return fmt.Errorf("database migration %d failed, %s is unchanged: %w", n, path, err)
		}
	}
	return nil
}

func (s *Store) step(n int, stmt, version string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, q := range []string{
		`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
		stmt,
		fmt.Sprintf(`PRAGMA user_version = %d`, n),
	} {
		if _, err := tx.Exec(q); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`INSERT INTO meta (key, value) VALUES ('written_by', ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value`, version); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) writtenBy() string {
	var v string
	if err := s.db.QueryRow(`SELECT value FROM meta WHERE key = 'written_by'`).Scan(&v); err != nil {
		return "unknown"
	}
	return v
}

// backup writes a consistent copy to <path>.bak-<old version> (VACUUM INTO,
// so a WAL is included), then deletes any older backups.
func (s *Store) backup(path, old string) error {
	dest := path + ".bak-" + old
	tmp := dest + ".tmp"
	os.Remove(tmp)
	if _, err := s.db.Exec(`VACUUM INTO ?`, tmp); err != nil {
		return fmt.Errorf("can't back up %s before migrating: %w", path, err)
	}
	if err := os.Rename(tmp, dest); err != nil {
		return fmt.Errorf("can't back up %s before migrating: %w", path, err)
	}
	others, _ := filepath.Glob(path + ".bak-*")
	for _, f := range others {
		if f != dest {
			os.Remove(f)
		}
	}
	return nil
}

// Errors the bridge turns into answers.
var (
	ErrNoSession  = errors.New("session not registered")
	ErrNotClaimed = errors.New("not claimed by this session")
)

func now() int64 { return time.Now().UnixMilli() }

func fromMillis(ms int64) time.Time { return time.UnixMilli(ms) }
