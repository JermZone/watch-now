package config

import (
	"testing"
	"time"
)

func TestLoadRequiresDispatcharrURL(t *testing.T) {
	t.Setenv("DISPATCHARR_URL", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected missing DISPATCHARR_URL to fail")
	}
}

func TestLoadAcceptsPathPrefixAndDefaults(t *testing.T) {
	t.Setenv("DISPATCHARR_URL", "https://example.test/dispatcharr/")
	t.Setenv("NOW_SESSION_IDLE_TIMEOUT", "45m")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if got := cfg.DispatcharrURL.String(); got != "https://example.test/dispatcharr" {
		t.Fatalf("DispatcharrURL = %q", got)
	}
	if cfg.SessionIdleTimeout != 45*time.Minute {
		t.Fatalf("SessionIdleTimeout = %v", cfg.SessionIdleTimeout)
	}
	if cfg.CookieSecure != "auto" {
		t.Fatalf("CookieSecure = %q", cfg.CookieSecure)
	}
	if cfg.EPGCacheTTL != 2*time.Minute || cfg.ArtworkCacheTTL != time.Hour || cfg.ArtworkMaxBytes != 2*1024*1024 {
		t.Fatalf("phase 2 cache defaults = EPG %v, artwork %v, max %d", cfg.EPGCacheTTL, cfg.ArtworkCacheTTL, cfg.ArtworkMaxBytes)
	}
	if cfg.CatalogCacheTTL != 2*time.Minute || cfg.DetailCacheTTL != 5*time.Minute || cfg.VLCSessionLimit != 1024 {
		t.Fatalf("VOD defaults = catalog %v, detail %v, VLC limit %d", cfg.CatalogCacheTTL, cfg.DetailCacheTTL, cfg.VLCSessionLimit)
	}
}

func TestLoadRejectsUnsafeDispatcharrURL(t *testing.T) {
	for _, value := range []string{
		"ftp://example.test",
		"https://viewer:secret@example.test",
		"https://example.test?token=secret",
	} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("DISPATCHARR_URL", value)
			if _, err := Load(); err == nil {
				t.Fatalf("Load() accepted %q", value)
			}
		})
	}
}

func TestLoadProgramSearchDefaultAndDisable(t *testing.T) {
	t.Setenv("DISPATCHARR_URL", "https://example.test")
	for _, item := range []struct {
		value   string
		enabled bool
	}{{"", true}, {"true", true}, {"false", false}} {
		t.Setenv("NOW_PROGRAM_SEARCH_ENABLED", item.value)
		cfg, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		if cfg.ProgramSearchEnabled != item.enabled {
			t.Fatalf("value %q: enabled = %v", item.value, cfg.ProgramSearchEnabled)
		}
	}
}
