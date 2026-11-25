package cli

import (
	"os/exec"
	"syscall"
)

// detach starts the bridge without a console and in its own process group,
// so it outlives the CLI.
func detach(cmd *exec.Cmd) {
	const detachedProcess = 0x00000008
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: detachedProcess | syscall.CREATE_NEW_PROCESS_GROUP}
}
