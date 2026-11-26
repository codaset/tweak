package cli

import (
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// The commands Claude runs on tweaks: watch (the Monitor command), work,
// plan, ask, done, decline and queue. See docs/design.md, "The tweak CLI".

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

// The status commands Claude finishes a step with: one tweak and Claude's
// message, sent as POST /tweaks/:n/status. Each prints "tweak <n>: <status>".
var (
	done    = withMessage("done", "done", "'<what you changed>'")
	ask     = withMessage("ask", "question", "'<your question>'")
	decline = withMessage("decline", "declined", "'<why not>'")
)

func withMessage(name, status, what string) func(*context, []string) error {
	usage := fmt.Sprintf("usage: tweak %s <n> %s, or - to read it from stdin", name, what)
	return func(c *context, args []string) error {
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
		cl, err := c.client()
		if err != nil {
			return err
		}
		return c.setStatus(cl, n, map[string]string{"status": status, "message": msg})
	}
}

// queue sets queued on one or more tweaks, one line each. A refused one
// says why on stderr and the rest still go through; the exit is then 1.
func queue(c *context, args []string) error {
	const usage = "usage: tweak queue <n>…, for example tweak queue 12 13"
	if len(args) == 0 {
		return usageError(usage)
	}
	var numbers []int64
	for _, a := range args {
		n, err := tweakArg(a, usage)
		if err != nil {
			return err
		}
		numbers = append(numbers, n)
	}
	cl, err := c.client()
	if err != nil {
		return err
	}
	var failed error
	for _, n := range numbers {
		if err := c.setStatus(cl, n, map[string]string{"status": "queued"}); err != nil {
			var refused *refusal
			if !errors.As(err, &refused) {
				return err // the bridge is gone: the rest would fail the same way
			}
			fmt.Fprintln(c.Stderr, err)
			failed = errShown
		}
	}
	return failed
}

// plan posts Claude's optional plan on a tweak it's working on.
func plan(c *context, args []string) error {
	const usage = "usage: tweak plan <n> '<your plan, naming the file>', or - to read it from stdin"
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
	cl, err := c.client()
	if err != nil {
		return err
	}
	if err := cl.call("POST", fmt.Sprintf("/tweaks/%d/entries", n), map[string]string{"kind": "plan", "text": msg}, nil); err != nil {
		return err
	}
	fmt.Fprintf(c.Stdout, "tweak %d: plan posted\n", n)
	return nil
}

// client is the session's connection to the bridge.
func (c *context) client() (*client, error) {
	if c.session == "" {
		return nil, errNoSession
	}
	return c.connect()
}

func (c *context) setStatus(cl *client, n int64, body map[string]string) error {
	var out struct {
		Number int64
		Status string
	}
	if err := cl.call("POST", fmt.Sprintf("/tweaks/%d/status", n), body, &out); err != nil {
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
