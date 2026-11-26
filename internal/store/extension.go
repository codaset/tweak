package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// The extension, as tweak claim's warnings and the watchers need it
// (docs/design.md, "The extension never connects"): when it was last
// connected, kept across restarts so "never connected" means never, and its
// connecting, which each session with claims hears as a line.

// EventExtensionConnected is the extension connecting, logged once for each
// session with claims: for its watcher only (the sockets skip it).
const EventExtensionConnected = "extension-connected"

// SawExtension records that the extension is connected now.
func (s *Store) SawExtension() error {
	_, err := s.db.Exec(`INSERT INTO meta (key, value) VALUES ('extension_seen', ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value`, fmt.Sprint(s.now()))
	return err
}

// ExtensionSeen is when the extension was last connected: zero if it never was.
func (s *Store) ExtensionSeen() (time.Time, error) {
	var raw string
	err := s.db.QueryRow(`SELECT value FROM meta WHERE key = 'extension_seen'`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return time.Time{}, nil
	}
	if err != nil {
		return time.Time{}, err
	}
	var ms int64
	if _, err := fmt.Sscan(raw, &ms); err != nil || ms <= 0 {
		return time.Time{}, nil
	}
	return fromMillis(ms), nil
}

// ExtensionConnected logs the extension connecting for each session that
// holds a claim.
func (s *Store) ExtensionConnected() error {
	tx, err := s.begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	claims, err := listClaims(tx)
	if err != nil {
		return err
	}
	told := map[string]bool{}
	for _, c := range claims {
		if told[c.Session.ID] {
			continue
		}
		told[c.Session.ID] = true
		payload, _ := json.Marshal(claimRecord{Session: c.Session.ID, Agent: c.Session.Agent, Folder: c.Session.Folder, Label: c.Session.Label})
		if _, err := tx.Exec(`INSERT INTO events (type, payload, at) VALUES (?, ?, ?)`, EventExtensionConnected, string(payload), s.now()); err != nil {
			return err
		}
		tx.logged = true
	}
	return tx.commit()
}
