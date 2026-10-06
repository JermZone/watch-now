package config

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestShareKeyConfiguration(t *testing.T) {
	t.Setenv("NOW_SHARE_KEY", "")
	t.Setenv("NOW_SHARE_KEY_FILE", "")
	t.Setenv("NOW_SHARE_KEY_DIR", "")
	if key, err := loadShareKey(); err != nil || key != nil {
		t.Fatal("sharing should default off")
	}
	t.Setenv("NOW_SHARE_KEY", strings.Repeat("ab", 32))
	key, err := loadShareKey()
	if err != nil || !bytes.Equal(key, bytes.Repeat([]byte{0xab}, 32)) {
		t.Fatal("valid key rejected")
	}
	path := filepath.Join(t.TempDir(), "private-key")
	os.WriteFile(path, []byte(strings.Repeat("ab", 32)+"\n"), 0600)
	t.Setenv("NOW_SHARE_KEY_FILE", path)
	if _, err := loadShareKey(); err == nil {
		t.Fatal("ambiguous sources accepted")
	}
	t.Setenv("NOW_SHARE_KEY", "")
	if key, err := loadShareKey(); err != nil || len(key) != 32 {
		t.Fatal("file key rejected")
	}
	for _, value := range []string{"", "secret-value", strings.Repeat("ab", 33), strings.Repeat("x", 129)} {
		os.WriteFile(path, []byte(value), 0600)
		if _, err := loadShareKey(); err == nil || strings.Contains(err.Error(), path) || strings.Contains(err.Error(), "secret-value") {
			t.Fatal("invalid key accepted or leaked")
		}
	}
}

func TestStoredShareKeyConcurrentAndPersistent(t *testing.T) {
	dir := t.TempDir()
	os.Chmod(dir, 0700)
	const count = 16
	keys := make([][]byte, count)
	errs := make([]error, count)
	var workers sync.WaitGroup
	for i := range count {
		workers.Go(func() { keys[i], errs[i] = storedShareKey(dir) })
	}
	workers.Wait()
	for i := range count {
		if errs[i] != nil || len(keys[i]) != 32 || !bytes.Equal(keys[0], keys[i]) {
			t.Fatal("concurrent starts must reuse one persisted key", errs[i])
		}
	}
	key, err := storedShareKey(dir)
	if err != nil || !bytes.Equal(key, keys[0]) {
		t.Fatal("restart changed key")
	}
	info, err := os.Stat(filepath.Join(dir, "share-key"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("key must remain private")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatal("temporary keys not cleaned up")
	}
	other := t.TempDir()
	os.Chmod(other, 0700)
	otherKey, err := storedShareKey(other)
	if err != nil || bytes.Equal(key, otherKey) {
		t.Fatal("installations must have independent keys")
	}
}

func TestStoredShareKeyRejectsDamageWithoutReplacing(t *testing.T) {
	for _, content := range []string{"", "secret-value", strings.Repeat("ab", 33), strings.Repeat("x", 129)} {
		dir := t.TempDir()
		os.Chmod(dir, 0700)
		path := filepath.Join(dir, "share-key")
		os.WriteFile(path, []byte(content), 0600)
		if _, err := storedShareKey(dir); err == nil {
			t.Fatal("damaged key accepted")
		}
		after, _ := os.ReadFile(path)
		if string(after) != content {
			t.Fatal("damaged key was replaced")
		}
	}
	for _, kind := range []string{"symlink", "directory", "public-key", "public-directory", "missing-directory"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			os.Chmod(dir, 0700)
			path := filepath.Join(dir, "share-key")
			switch kind {
			case "symlink":
				outside := filepath.Join(t.TempDir(), "key")
				os.WriteFile(outside, []byte(strings.Repeat("ab", 32)), 0600)
				if err := os.Symlink(outside, path); err != nil {
					t.Fatal(err)
				}
			case "directory":
				os.Mkdir(path, 0700)
			case "public-key":
				os.WriteFile(path, []byte(strings.Repeat("ab", 32)), 0644)
			case "public-directory":
				os.Chmod(dir, 0755)
			case "missing-directory":
				dir = filepath.Join(dir, "missing")
			}
			if _, err := storedShareKey(dir); err == nil {
				t.Fatal("unsafe storage accepted")
			}
		})
	}
}

func TestAutomaticShareStorageFailureKeepsServerConfigured(t *testing.T) {
	t.Setenv("DISPATCHARR_URL", "http://dispatcharr.test")
	t.Setenv("NOW_SHARE_KEY", "")
	t.Setenv("NOW_SHARE_KEY_FILE", "")
	t.Setenv("NOW_SHARE_KEY_DIR", filepath.Join(t.TempDir(), "missing"))
	cfg, err := Load()
	if err != nil || cfg.ShareKey != nil || !cfg.ShareStorageUnavailable {
		t.Fatal("automatic storage failure should disable sharing only", err)
	}
	t.Setenv("NOW_SHARE_KEY", strings.Repeat("ab", 32))
	cfg, err = Load()
	if err != nil || len(cfg.ShareKey) != 32 || cfg.ShareStorageUnavailable {
		t.Fatal("explicit key must take precedence over automatic storage", err)
	}
	t.Setenv("NOW_SHARE_KEY", "invalid-secret")
	if _, err = Load(); err == nil || strings.Contains(err.Error(), "invalid-secret") {
		t.Fatal("invalid explicit key must fail without leaking it")
	}
	t.Setenv("NOW_SHARE_KEY", "")
	file := filepath.Join(t.TempDir(), "explicit-key")
	os.WriteFile(file, []byte(strings.Repeat("ab", 32)), 0600)
	t.Setenv("NOW_SHARE_KEY_FILE", file)
	cfg, err = Load()
	if err != nil || len(cfg.ShareKey) != 32 || cfg.ShareStorageUnavailable {
		t.Fatal("explicit file must take precedence over automatic storage", err)
	}
}
