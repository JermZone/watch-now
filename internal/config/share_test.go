package config

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestShareKeyConfiguration(t *testing.T) {
	t.Setenv("NOW_SHARE_KEY", "")
	t.Setenv("NOW_SHARE_KEY_FILE", "")
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
