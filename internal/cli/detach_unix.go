//go:build !windows

package cli

import (
	"os/exec"
	"syscall"
)

// detach starts the bridge in its own session, so it outlives the CLI and
// isn't killed with the agent's process group.
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

// terminate asks a bridge that didn't shut down to stop: SIGTERM, which it
// handles as a shutdown.
func terminate(pid int) {
	if pid > 0 {
		syscall.Kill(pid, syscall.SIGTERM)
	}
}
