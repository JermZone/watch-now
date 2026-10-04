package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDVRKeyFileValidationAndRedactedErrors(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		valid      bool
	}{
		{"two accounts", `{"viewer":"viewer-key","admin":"admin-key"}`, true},
		{"empty", `{}`, true},
		{"duplicate", `{"viewer":"first","viewer":"second"}`, false},
		{"not object", `["private-secret"]`, false},
		{"not string", `{"viewer":123}`, false},
		{"blank user", `{"":"private-secret"}`, false},
		{"whitespace user", `{" viewer":"private-secret"}`, false},
		{"header injection", `{"viewer":"private-secret\nheader"}`, false},
		{"trailing", `{"viewer":"private-secret"} {}`, false},
		{"oversize", strings.Repeat("private-secret", 30000), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "private-secret.json")
			if err := os.WriteFile(path, []byte(tc.body), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("DISPATCHARR_URL", "http://dispatcharr.test")
			t.Setenv("NOW_DVR_API_KEYS_FILE", path)
			cfg, err := Load()
			if (err == nil) != tc.valid {
				t.Fatalf("unexpected validation result: %v", err)
			}
			if err != nil && strings.Contains(err.Error(), "private-secret") {
				t.Fatal("secret leaked in startup error")
			}
			if tc.name == "two accounts" && (cfg.DVRAPIKeys["viewer"] != "viewer-key" || cfg.DVRAPIKeys["admin"] != "admin-key") {
				t.Fatal("account keys not loaded")
			}
		})
	}
	if _, err := loadDVRKeys("/nonexistent/private-secret.json"); err == nil || strings.Contains(err.Error(), "private-secret") {
		t.Fatal("unsafe missing-file error")
	}
}

func TestDVRMasterKeyConfiguration(t *testing.T) {
	t.Setenv("DISPATCHARR_URL", "http://dispatcharr.test")
	t.Setenv("NOW_DVR_API_KEYS_FILE", "")
	t.Setenv("NOW_DVR_MASTER_API_KEY", "admin-fixture-key")
	t.Setenv("NOW_DVR_MASTER_API_KEY_FILE", "")
	cfg, err := Load()
	if err != nil || cfg.DVRMasterAPIKey != "admin-fixture-key" {
		t.Fatal("environment master key not loaded")
	}
	path := filepath.Join(t.TempDir(), "master.txt")
	os.WriteFile(path, []byte("admin-file-key\n"), 0600)
	t.Setenv("NOW_DVR_MASTER_API_KEY_FILE", path)
	if _, err := Load(); err == nil {
		t.Fatal("ambiguous key sources accepted")
	}
	t.Setenv("NOW_DVR_MASTER_API_KEY", "")
	cfg, err = Load()
	if err != nil || cfg.DVRMasterAPIKey != "admin-file-key" {
		t.Fatal("file master key not loaded")
	}
	t.Setenv("NOW_DVR_API_KEYS_FILE", path)
	if _, err := Load(); err == nil {
		t.Fatal("master and per-user sources accepted")
	}
	t.Setenv("NOW_DVR_API_KEYS_FILE", "")
	for _, value := range []string{"", strings.Repeat("secret", 200), "secret\nheader"} {
		os.WriteFile(path, []byte(value), 0600)
		if _, err := Load(); err == nil || strings.Contains(err.Error(), "secret") {
			t.Fatal("invalid key accepted or leaked")
		}
	}
}
