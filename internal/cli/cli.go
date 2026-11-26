// Package cli is the tweak command line: the commands the /tweak skill runs,
// and `tweak bridge`, which runs the bridge itself.
package cli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/codaset/tweak/internal/config"
	"github.com/codaset/tweak/internal/version"
)

// Env is what a command reads from its surroundings.
type Env struct {
	Getenv func(string) string
	Home   string
	Dir    string // working folder: the session's project
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
}

// OSEnv is the process's own environment.
func OSEnv() Env {
	home, _ := os.UserHomeDir()
	dir, _ := os.Getwd()
	return Env{Getenv: os.Getenv, Home: home, Dir: dir, Stdin: os.Stdin, Stdout: os.Stdout, Stderr: os.Stderr}
}

// Run runs one command and returns the exit code: 0, 1 when the command
// failed (one line on stderr saying what to do), 2 for a usage error.
func Run(args []string, env Env) int {
	if len(args) == 0 {
		usage(env.Stderr)
		return 2
	}
	rest, session := sessionFlag(args[1:])
	if session == "" {
		session = env.Getenv("CLAUDE_CODE_SESSION_ID")
	}
	cmd := args[0]
	if cmd == "hook" {
		return runHook(rest, env)
	}
	if cmd == "version" {
		fmt.Fprintf(env.Stdout, "binary %s\nprotocol %d\n", version.Version, version.Protocol)
		return 0
	}
	commands := map[string]func(*context, []string) error{
		"bridge":  runBridge,
		"claim":   claim,
		"claims":  listClaims,
		"release": release,
		"watch":   watch,
		"work":    work,
		"plan":    plan,
		"ask":     ask,
		"done":    done,
		"decline": decline,
		"queue":   queue,
	}
	f, ok := commands[cmd]
	if !ok {
		fmt.Fprintf(env.Stderr, "unknown command %q: run tweak with no arguments to list commands\n", cmd)
		return 2
	}
	cfg, err := config.Resolve(env.Getenv, env.Home)
	if err != nil {
		fmt.Fprintln(env.Stderr, err)
		return 1
	}
	err = f(&context{Env: env, cfg: cfg, session: session}, rest)
	var u usageError
	switch {
	case errors.As(err, &u):
		fmt.Fprintln(env.Stderr, err)
		return 2
	case err != nil:
		fmt.Fprintln(env.Stderr, err)
		return 1
	}
	return 0
}

type context struct {
	Env
	cfg     config.Config
	session string
}

type usageError string

func (u usageError) Error() string { return string(u) }

var errNoSession = errors.New("no session ID: run tweak inside Claude Code (CLAUDE_CODE_SESSION_ID), or pass --session <id>")

// sessionFlag takes --session <id> or --session=<id> from anywhere in args.
func sessionFlag(args []string) (rest []string, session string) {
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--session" && i+1 < len(args):
			session = args[i+1]
			i++
		case strings.HasPrefix(a, "--session="):
			session = strings.TrimPrefix(a, "--session=")
		default:
			rest = append(rest, a)
		}
	}
	return rest, session
}

func usage(w io.Writer) {
	fmt.Fprint(w, `usage: tweak <command> [--session <id>]

commands:
  claim <url>        claim the pages matching a URL pattern for this session
  claims             list every claim and its session
  release [pattern]  release one claim, or all of this session's
  watch              print one line per new tweak, reply, tweak sent again or released claim (the Monitor command)
  work <n>           print tweak n's brief and mark it as being worked on
  plan <n> <msg>     post a short plan for tweak n, naming the file
  ask <n> <msg>      ask the developer a question about tweak n
  done <n> <msg>     mark tweak n done, with one sentence on what changed
  decline <n> <msg>  decline tweak n, with the reason
  queue <n>...       mark tweaks as queued while other work finishes
  version            print the binary and protocol versions

The session ID comes from CLAUDE_CODE_SESSION_ID, or --session. A message
argument of - reads the message from stdin.
`)
}
