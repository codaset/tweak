package cli

import (
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/codaset/tweak/internal/bridge"
	"github.com/codaset/tweak/internal/version"
)

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
	byCLI := c.Getenv(envStartedByCLI) != ""
	status := func(line string) {
		fmt.Fprintln(c.Stdout, line)
		if f, ok := c.Stdout.(*os.File); ok && byCLI {
			f.Close()
			c.Stdout = c.Stderr
		}
	}

	b, err := bridge.Start(bridge.Options{Config: c.cfg, Version: version.Version, Development: c.Getenv("TWEAK_BIN") != "", Log: c.Stderr})
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
		<-signals
		b.Shutdown()
	}()
	return b.Serve()
}
