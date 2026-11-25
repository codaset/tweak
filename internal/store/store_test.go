package store

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/codaset/tweak/internal/pattern"
)

func open(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "tweak.db"), "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func mustParse(t *testing.T, s string) pattern.Pattern {
	t.Helper()
	p, err := pattern.Parse(s)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func register(t *testing.T, s *Store, id, folder string) {
	t.Helper()
	if err := s.RegisterSession(Session{ID: id, Agent: "claude-code", Folder: folder}); err != nil {
		t.Fatal(err)
	}
}

func TestNewDatabaseHasTheDataModel(t *testing.T) {
	s := open(t)
	for _, table := range []string{"sessions", "claims", "tweaks", "entries", "changes", "change_files", "events", "deliveries"} {
		var n int
		if err := s.db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&n); err != nil || n != 1 {
			t.Errorf("table %s missing (%v)", table, err)
		}
	}
}

func TestANewerDatabaseIsRefused(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tweak.db")
	newer := append(append([]string{}, migrations...), `CREATE TABLE later (x)`)
	s, err := openWith(path, "1.4.0", newer)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()

	_, err = openWith(path, "1.3.2", migrations)
	if err == nil || err.Error() != "database is from Tweak 1.4.0; this is 1.3.2" {
		t.Fatalf("got %v", err)
	}
}

func TestAFailedMigrationLeavesTheDatabaseUntouched(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tweak.db")
	s, err := openWith(path, "1.0.0", []string{`CREATE TABLE one (x)`})
	if err != nil {
		t.Fatal(err)
	}
	s.Close()

	_, err = openWith(path, "1.1.0", []string{`CREATE TABLE one (x)`, `CREATE TABLE two (x); INSERT INTO nowhere VALUES (1)`})
	if err == nil {
		t.Fatal("broken migration succeeded")
	}

	s, err = openWith(path, "1.0.0", []string{`CREATE TABLE one (x)`})
	if err != nil {
		t.Fatalf("database no longer opens at its old version: %v", err)
	}
	defer s.Close()
	var n int
	s.db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE name='two'`).Scan(&n)
	if n != 0 {
		t.Fatal("half a migration was kept")
	}
}

func TestMigratingKeepsOnlyTheNewestBackup(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tweak.db")
	steps := []string{`CREATE TABLE one (x); INSERT INTO one VALUES ('kept')`}
	s, err := openWith(path, "1.0.0", steps)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()

	steps = append(steps, `CREATE TABLE two (x)`)
	if s, err = openWith(path, "1.1.0", steps); err != nil {
		t.Fatal(err)
	}
	s.Close()
	steps = append(steps, `CREATE TABLE three (x)`)
	if s, err = openWith(path, "1.2.0", steps); err != nil {
		t.Fatal(err)
	}
	s.Close()

	backups, _ := filepath.Glob(path + ".bak-*")
	if len(backups) != 1 || filepath.Base(backups[0]) != "tweak.db.bak-1.1.0" {
		t.Fatalf("backups %v, want only tweak.db.bak-1.1.0", backups)
	}
	// The backup is the database as it was before migrating to 1.2.0.
	b, err := openWith(backups[0], "1.1.0", steps[:2])
	if err != nil {
		t.Fatalf("backup doesn't open at 1.1.0: %v", err)
	}
	defer b.Close()
	var x string
	if err := b.db.QueryRow(`SELECT x FROM one`).Scan(&x); err != nil || x != "kept" {
		t.Fatalf("backup lost data: %q %v", x, err)
	}
}

func TestOpeningAnUpToDateDatabaseMakesNoBackup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tweak.db")
	for range 2 {
		s, err := Open(path, "1.0.0")
		if err != nil {
			t.Fatal(err)
		}
		s.Close()
	}
	if backups, _ := filepath.Glob(path + ".bak-*"); len(backups) != 0 {
		t.Fatalf("unexpected backups %v", backups)
	}
}

func TestOpenFailsOnAnUnreadableFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tweak.db")
	os.WriteFile(path, []byte("not a database, not at all, not even close to one"), 0o600)
	if _, err := Open(path, "1.0.0"); err == nil {
		t.Fatal("opened garbage")
	}
}

func TestRegisteringASessionAgainUpdatesIt(t *testing.T) {
	s := open(t)
	register(t, s, "s1", "/dev/ernie")
	register(t, s, "s1", "/dev/ernie-2")
	got, err := s.Session("s1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Folder != "/dev/ernie-2" || got.Agent != "claude-code" {
		t.Fatalf("got %+v", got)
	}
}

func TestCheckInMovesTheLastCheckIn(t *testing.T) {
	s := open(t)
	register(t, s, "s1", "/dev/ernie")
	before, _ := s.Session("s1")
	s.db.Exec(`UPDATE sessions SET last_check_in = 0`)
	known, err := s.CheckIn("s1")
	if err != nil || !known {
		t.Fatalf("known %v, err %v", known, err)
	}
	after, _ := s.Session("s1")
	if after.LastCheckIn.Before(before.LastCheckIn) {
		t.Fatalf("check-in didn't move: %v -> %v", before.LastCheckIn, after.LastCheckIn)
	}
	if known, _ := s.CheckIn("nobody"); known {
		t.Fatal("an unknown session checked in")
	}
}

func TestCheckInEverySessionCountsDowntimeOut(t *testing.T) {
	s := open(t)
	register(t, s, "s1", "/dev/ernie")
	s.db.Exec(`UPDATE sessions SET last_check_in = 0`)
	if err := s.CheckInAll(); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Session("s1")
	if got.LastCheckIn.Year() < 2026 {
		t.Fatalf("last check-in %v", got.LastCheckIn)
	}
}

func TestClaimsAreExclusive(t *testing.T) {
	s := open(t)
	register(t, s, "s1", "/dev/ernie")
	register(t, s, "s2", "/dev/ernie-2")

	c, err := s.Claim("s1", mustParse(t, "https://ernie.localhost"))
	if err != nil {
		t.Fatal(err)
	}
	if c.Pattern != "https://ernie.localhost/*" || c.Session.Folder != "/dev/ernie" {
		t.Fatalf("got %+v", c)
	}

	_, err = s.Claim("s2", mustParse(t, "https://ernie.localhost/admin/*"))
	var overlap *OverlapError
	if !errors.As(err, &overlap) {
		t.Fatalf("got %v, want an overlap", err)
	}
	if overlap.Holder.Pattern != "https://ernie.localhost/*" || overlap.Holder.Session.ID != "s1" {
		t.Fatalf("holder %+v", overlap.Holder)
	}
	if !strings.Contains(err.Error(), "https://ernie.localhost/*") || !strings.Contains(err.Error(), "/dev/ernie") {
		t.Fatalf("message %q should name the pattern and the session's folder", err)
	}

	if _, err := s.Claim("s2", mustParse(t, "https://bert.localhost/*")); err != nil {
		t.Fatalf("a separate site: %v", err)
	}
}

func TestASessionMayClaimAgainButNotInsideItsOwnClaim(t *testing.T) {
	s := open(t)
	register(t, s, "s1", "/dev/ernie")
	first, _ := s.Claim("s1", mustParse(t, "https://ernie.localhost/*"))
	again, err := s.Claim("s1", mustParse(t, "https://ernie.localhost/"))
	if err != nil || again.ID != first.ID {
		t.Fatalf("claiming the same pattern again: %+v %v", again, err)
	}
	_, err = s.Claim("s1", mustParse(t, "https://ernie.localhost/admin/*"))
	var overlap *OverlapError
	if !errors.As(err, &overlap) || overlap.Holder.ID != first.ID {
		t.Fatalf("inside its own claim: got %v, want an overlap with claim %d", err, first.ID)
	}
}

func TestClaimNeedsARegisteredSession(t *testing.T) {
	s := open(t)
	if _, err := s.Claim("nobody", mustParse(t, "https://ernie.localhost/*")); !errors.Is(err, ErrNoSession) {
		t.Fatalf("got %v", err)
	}
}

func TestReleaseOneOrAll(t *testing.T) {
	s := open(t)
	register(t, s, "s1", "/dev/ernie")
	register(t, s, "s2", "/dev/bert")
	s.Claim("s1", mustParse(t, "https://ernie.localhost/*"))
	s.Claim("s1", mustParse(t, "https://ernie.test/*"))
	s.Claim("s2", mustParse(t, "https://bert.localhost/*"))

	got, err := s.Release("s1", "https://ernie.test/*")
	if err != nil || len(got) != 1 || got[0] != "https://ernie.test/*" {
		t.Fatalf("release one: %v %v", got, err)
	}
	if _, err := s.Release("s1", "https://bert.localhost/*"); !errors.Is(err, ErrNotClaimed) {
		t.Fatalf("releasing another session's claim: %v", err)
	}
	got, err = s.Release("s1", "")
	if err != nil || len(got) != 1 || got[0] != "https://ernie.localhost/*" {
		t.Fatalf("release all: %v %v", got, err)
	}
	all, _ := s.Claims()
	if len(all) != 1 || all[0].Session.ID != "s2" {
		t.Fatalf("left %+v", all)
	}
	if n, _ := s.ClaimCount(); n != 1 {
		t.Fatalf("count %d", n)
	}
}
