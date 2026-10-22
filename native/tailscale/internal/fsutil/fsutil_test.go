package fsutil

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestEnsurePrivateDirTightensOwnDirectory(t *testing.T) {
	d := filepath.Join(t.TempDir(), "a", "b")
	if err := os.MkdirAll(d, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(d, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := EnsurePrivateDir(d); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(d); fi.Mode().Perm() != 0o700 {
		t.Fatalf("mode %04o", fi.Mode().Perm())
	}
	f := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(f, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnsurePrivateDir(f); err == nil {
		t.Fatal("accepted a regular file")
	}
}

func TestCheckPrivateDirOnlyReports(t *testing.T) {
	d := t.TempDir()
	if err := os.Chmod(d, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := CheckPrivateDir(d); err == nil {
		t.Fatal("accepted a group-readable directory")
	}
	if fi, _ := os.Stat(d); fi.Mode().Perm() != 0o750 {
		t.Fatal("CheckPrivateDir changed the mode")
	}
	if err := os.Chmod(d, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := CheckPrivateDir(d); err != nil {
		t.Fatal(err)
	}
}

func TestLockIsExclusiveUntilClosed(t *testing.T) {
	p := filepath.Join(t.TempDir(), "lock")
	a, err := Lock(p)
	if err != nil {
		t.Fatal(err)
	}
	// flock conflicts between separate open file descriptions, even within
	// one process, so this models a second daemon.
	if _, err := Lock(p); !errors.Is(err, ErrLocked) {
		t.Fatalf("second lock: %v", err)
	}
	a.Close()
	b, err := Lock(p)
	if err != nil {
		t.Fatalf("lock after release: %v", err)
	}
	b.Close()
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o600 {
		t.Fatalf("lock file mode %04o", fi.Mode().Perm())
	}
}

func TestLockHeldObservesWithoutCreatingOrKeeping(t *testing.T) {
	p := filepath.Join(t.TempDir(), "lock")
	if held, err := LockHeld(p); err != nil || held {
		t.Fatalf("missing file: held=%v err=%v", held, err)
	}
	if _, err := os.Stat(p); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the probe created the lock file: %v", err)
	}
	a, err := Lock(p)
	if err != nil {
		t.Fatal(err)
	}
	if held, err := LockHeld(p); err != nil || !held {
		t.Fatalf("while locked: held=%v err=%v", held, err)
	}
	a.Close()
	if held, err := LockHeld(p); err != nil || held {
		t.Fatalf("after release: held=%v err=%v", held, err)
	}
	// The probe kept nothing: the lock can be taken right after it.
	b, err := Lock(p)
	if err != nil {
		t.Fatalf("lock after probe: %v", err)
	}
	b.Close()
}

func TestEnsureManagedDirRefusesWithoutRepair(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "managed")
	if err := EnsureManagedDir(dir); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := EnsureManagedDir(dir); err == nil {
		t.Fatal("accepted mode 0755")
	}
	if fi, _ := os.Lstat(dir); fi.Mode().Perm() != 0o755 {
		t.Fatal("changed existing mode")
	}
	alias := filepath.Join(root, "alias")
	if err := os.Symlink(dir, alias); err != nil {
		t.Fatal(err)
	}
	if err := EnsureManagedDir(alias); err == nil {
		t.Fatal("accepted symbolic link")
	}
}
