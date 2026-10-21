// Package fsutil holds the file-permission and locking primitives that make
// the local sockets and node state reachable only by the owning OS user.
package fsutil

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"syscall"
)

// MaxSocketPath is the portable bound on a Unix socket path. macOS limits
// sun_path to 104 bytes including the terminator; Linux allows 108.
const MaxSocketPath = 103

// EnsurePrivateDir creates path (and parents) if needed and makes it a 0700
// directory owned by the current user. An existing directory with group or
// other permission bits is tightened rather than rejected: it is the
// owner's own directory and tightening cannot lose data. A directory owned
// by another user is refused.
func EnsurePrivateDir(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	fi, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return fmt.Errorf("%s is not a directory", path)
	}
	if err := checkOwner(path, fi); err != nil {
		return err
	}
	if fi.Mode().Perm() != 0o700 {
		if err := os.Chmod(path, 0o700); err != nil {
			return err
		}
	}
	return nil
}

// CheckPrivateDir verifies, without changing anything, that path is a
// directory owned by the current user with no group or other permissions.
// It is used for directories another process (the Node server) created.
func CheckPrivateDir(path string) error {
	fi, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return fmt.Errorf("%s is not a directory", path)
	}
	if err := checkOwner(path, fi); err != nil {
		return err
	}
	if fi.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("%s has mode %04o; want no group or other access", path, fi.Mode().Perm())
	}
	return nil
}

func checkOwner(path string, fi fs.FileInfo) error {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("cannot read owner of %s", path)
	}
	if int(st.Uid) != os.Geteuid() {
		return fmt.Errorf("%s is owned by uid %d, not the current user", path, st.Uid)
	}
	return nil
}

// CheckSocketPath rejects socket paths the kernel would refuse with an
// unhelpful EINVAL.
func CheckSocketPath(path string) error {
	if len(path) > MaxSocketPath {
		return fmt.Errorf("socket path is %d bytes; the limit is %d: %s", len(path), MaxSocketPath, path)
	}
	return nil
}

// ErrLocked reports that another process holds the lock.
var ErrLocked = errors.New("lock is held by another process")

// Lock takes a non-blocking exclusive flock on path, creating it 0600. The
// kernel releases the lock when the returned file is closed or the process
// exits for any reason, including SIGKILL, so a crashed owner never leaves a
// stale lock behind. The lock, not the presence of a socket file, decides
// ownership.
func Lock(path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrLocked
		}
		return nil, err
	}
	return f, nil
}

// LockHeld reports whether another open file description holds Lock's lock
// on path, without creating the file or keeping any lock. A missing file was
// never locked. The probe takes a shared lock for an instant: while it is
// held a concurrent Lock fails with ErrLocked, which a caller of Lock already
// treats as "someone else owns it right now" and retries.
func LockHeld(path string) (bool, error) {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_SH|syscall.LOCK_NB); err != nil {
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return true, nil
		}
		return false, err
	}
	// Closing the descriptor releases the shared lock.
	return false, nil
}
