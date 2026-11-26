package cli

import (
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/codaset/tweak/internal/bridge"
	"github.com/codaset/tweak/internal/version"
)

// testBridge breaks `tweak bridge` in a test build, for the handover's
// rollback tests: "exit" exits at once, saying nothing, and "hang" never
// answers. Only those tests set it, with -ldflags -X; a release never does.
var testBridge string

// testBuild, set with -ldflags -X by the CLI tests' release builds (which run
// without TWEAK_BIN), lets those builds read the TWEAK_TEST_* knobs too. A
// release never sets it.
var testBuild string

// runBridge is `tweak bridge`: it runs the bridge in the foreground until it
// is shut down, idles out, or gets SIGINT or SIGTERM.
//
// Started by the CLI (TWEAK_STARTED_BY_CLI), stdout is a pipe to the CLI that
// started it: the first line says how the start went, then stdout is closed,
// so the CLI, and the agent's shell above it, don't wait on the bridge.
func runBridge(c *context, args []string) error {
	if len(args) != 0 {
		return usageError("usage: tweak bridge")
	}
	switch testBridge {
	case "exit":
		return nil
	case "hang":
		time.Sleep(time.Hour) // killed by the CLI waiting on it
	}
	byCLI := c.Getenv(envStartedByCLI) != ""
	status := func(line string) {
		fmt.Fprintln(c.Stdout, line)
		if f, ok := c.Stdout.(*os.File); ok && byCLI {
			f.Close()
			c.Stdout = c.Stderr
		}
	}

	b, err := bridge.Start(bridge.Options{Config: c.cfg, Version: version.Version, Development: c.Getenv("TWEAK_BIN") != "",
		AgainAfter:     testDuration(c.Getenv, "TWEAK_TEST_AGAIN_AFTER"),
		LapseAfter:     testDuration(c.Getenv, "TWEAK_TEST_LAPSE_AFTER"),
		UnwatchedAfter: testDuration(c.Getenv, "TWEAK_TEST_UNWATCHED_AFTER"),
		KeepResolved:   testDuration(c.Getenv, "TWEAK_TEST_KEEP_RESOLVED"),
		Log:            c.Stderr})
	if errors.Is(err, bridge.ErrAlreadyRunning) {
		if byCLI {
			status(lineAlready)
		}
		return nil // two starts raced on the port: the other bridge won
	}
	if err != nil {
		if byCLI {
			status(err.Error())
		}
		return err
	}
	status(fmt.Sprintf("%s%d", lineListening, b.Port()))

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		for range signals {
			if b.Stopping() {
				// Already shutting down, and taking too long (a handover's
				// SIGTERM): go now. SQLite keeps every committed write, and
				// the next bridge replaces bridge.json.
				os.Exit(1)
			}
			b.Shutdown()
		}
	}()
	return b.Serve()
}

// testDuration reads one of the test-only knobs, each a Go duration such as
// 2s, so the e2e suite needn't wait minutes:
//   - TWEAK_TEST_AGAIN_AFTER: how long a delivered tweak waits for Claude
//     before the bridge sends it again (3 minutes);
//   - TWEAK_TEST_LAPSE_AFTER: how long a session may go without checking
//     in before its claims lapse (10 minutes);
//   - TWEAK_TEST_UNWATCHED_AFTER: how long a session with claims may have
//     no watcher before its commands warn (60 seconds);
//   - TWEAK_TEST_KEEP_RESOLVED: how long a resolved tweak is kept (7 days);
//   - TWEAK_TEST_WATCH_START_AFTER: how long tweak watch goes without an
//     answer before it starts the bridge itself (10 seconds);
//   - TWEAK_TEST_HANDOVER_STOP and TWEAK_TEST_HANDOVER_START: how long a
//     handover gives the old bridge to free the port, and the new one to
//     start and answer (5 seconds each).
//
// Only a development build (TWEAK_BIN set) or a test build (testBuild)
// reads them; otherwise, or when one isn't a positive duration, it is 0,
// the default.
func testDuration(getenv func(string) string, name string) time.Duration {
	if getenv == nil || getenv("TWEAK_BIN") == "" && testBuild == "" {
		return 0
	}
	d, err := time.ParseDuration(getenv(name))
	if err != nil || d <= 0 {
		return 0
	}
	return d
}

// knob is the test-only knob name if it is set (see testDuration), else def.
func (c *context) knob(name string, def time.Duration) time.Duration {
	if d := testDuration(c.Getenv, name); d > 0 {
		return d
	}
	return def
}
