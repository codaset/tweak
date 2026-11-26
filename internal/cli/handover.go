package cli

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"time"

	"github.com/codaset/tweak/internal/bridge"
	"github.com/codaset/tweak/internal/version"
)

// Handing over to a newer bridge (docs/design.md, "Installation and
// updates", and "A handover that fails").
const (
	// handoverStop is how long the old bridge has to free the port after
	// POST /shutdown, before it is sent SIGTERM.
	handoverStop = 5 * time.Second
	// handoverStart is how long the new bridge has to start and answer.
	handoverStart = 5 * time.Second
	// handoverPoll is how often the port is looked at meanwhile.
	handoverPoll = 100 * time.Millisecond
)

// handover replaces old, a bridge older than this binary, with this
// version's, and returns a client for whichever bridge it leaves running:
//
//  1. POST /shutdown, then up to 5 seconds for the port to free, then
//     SIGTERM to the PID old gave;
//  2. this binary's bridge, which has 5 seconds to start and answer;
//  3. failing that, the old version's binary again, from bin/<version>/,
//     with a warning; failing that too, an error naming both, and the
//     database backup.
//
// Another command handing over at the same moment races it for the port:
// whichever bridge binds it wins, the other exits quietly, and both
// commands use the winner. While a handover runs, the handover file says
// so, for tweak hook pre-edit to wait for the new bridge.
func (c *context) handover(old *client, info bridge.Info) (*client, error) {
	marker := c.cfg.Handover()
	writeWhole(marker, strconv.Itoa(os.Getpid())+"\n")
	defer os.Remove(marker)

	// Only the bridge found (its PID), never one another command's handover
	// has started since: that one refuses.
	old.callWithin(2*time.Second, "POST", "/shutdown?pid="+strconv.Itoa(info.PID), nil, nil)
	if cl := c.awaitFreePort(old.port, info.PID); cl != nil {
		return cl, nil // another command's handover won
	}

	exe, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("couldn't start bridge %s (%v)", version.Version, err)
	}
	cl, newErr := c.startedFrom(exe, handoverStart, false)
	if newErr == nil {
		return cl, nil
	}
	cl, oldErr := c.startedFrom(keptBinary(c.cfg.StateDir, info.Version), 10*time.Second, true)
	if oldErr == nil {
		fmt.Fprintf(c.Stderr, "couldn't start bridge %s (%v); kept %s running\n", version.Version, newErr, info.Version)
		return cl, nil
	}
	return nil, fmt.Errorf("couldn't start bridge %s (%v), nor %s again (%v)%s", version.Version, newErr, info.Version, oldErr, c.backupNote())
}

// awaitFreePort waits for the old bridge to let go of port, then sends it
// SIGTERM if it hasn't (to the PID it gave, never one read since, which
// may be the winner's). A bridge at this version or newer answering
// meanwhile is another command's handover having won: it returns a client
// for it.
func (c *context) awaitFreePort(port, pid int) *client {
	deadline := time.Now().Add(handoverStop)
	for {
		if portFree(port) {
			return nil
		}
		if cl := c.current(port); cl != nil {
			return cl
		}
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(handoverPoll)
	}
	terminate(pid)
	for end := time.Now().Add(time.Second); time.Now().Before(end) && !portFree(port); {
		time.Sleep(handoverPoll)
	}
	return nil
}

// startedFrom starts the bridge binary at path, and returns a client once
// a bridge answers on its port. Another command's bridge may have won the
// port: one at this version or newer is as good as ours. An older one
// still there counts as a failed start, unless older is true (the previous
// version starting again).
func (c *context) startedFrom(path string, within time.Duration, older bool) (*client, error) {
	began := time.Now()
	port, err := c.startBinary(path, within)
	if err != nil {
		// A losing bridge can take a while to step aside: the winner may be up.
		if cl := c.current(c.cfg.Port); cl != nil {
			return cl, nil
		}
		return nil, err
	}
	for {
		cl := c.newClient()
		if info, ok := cl.ping(port); ok {
			cl.port = port
			if !older && version.Older(info.Version, version.Version) {
				return nil, fmt.Errorf("bridge %s is still running on port %d", info.Version, port)
			}
			return cl, nil
		}
		if time.Since(began) > within {
			return nil, fmt.Errorf("the bridge didn't answer within %s (log: %s)", seconds(within), c.cfg.Log())
		}
		time.Sleep(handoverPoll)
	}
}

// current is a client for a bridge on port at this version or newer, or nil.
func (c *context) current(port int) *client {
	cl := c.newClient()
	info, ok := cl.ping(port)
	if !ok || version.Older(info.Version, version.Version) {
		return nil
	}
	cl.port = port
	return cl
}

// keptBinary is where the launcher keeps a version's binary.
func keptBinary(stateDir, v string) string {
	name := "tweak"
	if runtime.GOOS == "windows" {
		name = "tweak.exe"
	}
	return filepath.Join(stateDir, "bin", v, name)
}

// backupNote names the database backup a migration left, if any: the way
// back when neither version's bridge will start.
func (c *context) backupNote() string {
	backups, _ := filepath.Glob(c.cfg.Database() + ".bak-*")
	if len(backups) == 0 {
		return ""
	}
	return "; the database backup is " + backups[len(backups)-1]
}

// portFree reports whether nothing listens on port.
func portFree(port int) bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), handoverPoll)
	if err != nil {
		return true
	}
	conn.Close()
	return false
}

// seconds is a whole-second duration as text: "5 seconds".
func seconds(d time.Duration) string {
	return fmt.Sprintf("%d seconds", int(d.Seconds()))
}
