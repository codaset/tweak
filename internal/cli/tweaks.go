package cli

import (
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// The commands Claude runs on tweaks: watch (the Monitor command), work and
// done. See docs/design.md, "The tweak CLI".

// inboxTimeout outlasts the bridge's long-poll hold.
const inboxTimeout = 60 * time.Second

// ackTimeout bounds the acknowledgement watch sends before it exits.
const ackTimeout = 5 * time.Second

// watchBackoff is how long watch waits before asking again after the bridge
// didn't answer: 1, 2, 5 seconds, then every 10.
var watchBackoff = []time.Duration{time.Second, 2 * time.Second, 5 * time.Second, 10 * time.Second}

var errWatchNoClaims = errors.New("this session has no claims: run tweak claim <url> first, then tweak watch")

// watch long-polls the session's inbox and prints one line per event. It
// exits at once for a session with no claims, and after "claim released"
// once none are left. A bridge that stops answering is asked again with
// backoff (the next connect starts one if none is running); a bridge that
// refuses, or can't be started, ends it.
func watch(c *context, args []string) error {
	if len(args) != 0 {
		return usageError("usage: tweak watch")
	}
	if c.session == "" {
		return errNoSession
	}
	after := int64(-1) // where the last watcher left off
	first, attempt := true, 0
	for {
		cl, err := c.connect()
		if err != nil {
			return err
		}
		path := "/inbox"
		if after >= 0 {
			path += "?after=" + strconv.FormatInt(after, 10)
		}
		var in struct {
			Seq    int64
			Claims int
			Lines  []struct{ Text string }
		}
		err = cl.callWithin(inboxTimeout, "GET", path, nil, &in)
		var refused *refusal
		switch {
		case errors.As(err, &refused):
			return err
		case err != nil:
			time.Sleep(watchBackoff[min(attempt, len(watchBackoff)-1)])
			attempt++
			continue
		}
		attempt = 0
		// A fresh read holds no old releases, so lines here are this watcher's.
		if first && in.Claims == 0 && len(in.Lines) == 0 {
			return errWatchNoClaims
		}
		first = false
		for _, l := range in.Lines {
			fmt.Fprintln(c.Stdout, l.Text)
		}
		// Asking after in.Seq next acknowledges these lines.
		after = in.Seq
		if in.Claims == 0 {
			// No next poll: acknowledge now, or the next watcher prints them
			// again. The bridge acknowledges before it would hold the request,
			// so a short wait is enough; a failed ack only means a repeat.
			if len(in.Lines) > 0 {
				cl.callWithin(ackTimeout, "GET", "/inbox?after="+strconv.FormatInt(after, 10), nil, nil)
			}
			return nil
		}
	}
}

// tweakArg reads a tweak number.
func tweakArg(s, usage string) (int64, error) {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 1 {
		return 0, usageError(usage)
	}
	return n, nil
}

// work prints the brief and sets working.
func work(c *context, args []string) error {
	const usage = "usage: tweak work <n>, for example tweak work 12"
	if len(args) != 1 {
		return usageError(usage)
	}
	n, err := tweakArg(args[0], usage)
	if err != nil {
		return err
	}
	if c.session == "" {
		return errNoSession
	}
	cl, err := c.connect()
	if err != nil {
		return err
	}
	brief, err := cl.text("POST", fmt.Sprintf("/tweaks/%d/work", n))
	if err != nil {
		return err
	}
	_, err = io.WriteString(c.Stdout, brief)
	return err
}

// done sets done with Claude's summary.
func done(c *context, args []string) error {
	const usage = "usage: tweak done <n> '<what you changed>', or - to read it from stdin"
	if len(args) != 2 {
		return usageError(usage)
	}
	n, err := tweakArg(args[0], usage)
	if err != nil {
		return err
	}
	msg, err := c.message(args[1])
	if err != nil {
		return err
	}
	if c.session == "" {
		return errNoSession
	}
	cl, err := c.connect()
	if err != nil {
		return err
	}
	var out struct {
		Number int64
		Status string
	}
	if err := cl.call("POST", fmt.Sprintf("/tweaks/%d/status", n), map[string]string{"status": "done", "message": msg}, &out); err != nil {
		return err
	}
	fmt.Fprintf(c.Stdout, "tweak %d: %s\n", out.Number, out.Status)
	return nil
}

// message is a message argument: the text itself, or - to read it from stdin.
func (c *context) message(arg string) (string, error) {
	if arg != "-" {
		return arg, nil
	}
	if c.Stdin == nil {
		return "", errors.New("no stdin to read the message from: pass the message as an argument instead")
	}
	raw, err := io.ReadAll(c.Stdin)
	if err != nil {
		return "", fmt.Errorf("couldn't read the message from stdin (%v): pass the message as an argument instead", err)
	}
	return strings.TrimRight(string(raw), "\r\n"), nil
}
