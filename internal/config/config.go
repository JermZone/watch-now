package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	defaultListenAddress     = ":8080"
	defaultSessionIdle       = 30 * time.Minute
	defaultSessionAbsolute   = 12 * time.Hour
	defaultUpstreamTimeout   = 20 * time.Second
	defaultCategoryCacheTTL  = 5 * time.Minute
	defaultChannelCacheTTL   = 30 * time.Second
	defaultEPGCacheTTL       = 2 * time.Minute
	defaultArtworkCacheTTL   = time.Hour
	defaultCatalogCacheTTL   = 2 * time.Minute
	defaultDetailCacheTTL    = 5 * time.Minute
	defaultDiagnosticCacheTT = 30 * time.Second
)

type Config struct {
	ProgramSearchEnabled  bool
	ListenAddress         string
	DispatcharrURL        *url.URL
	WebRoot               string
	CookieSecure          string
	TrustProxyHeaders     bool
	SessionIdleTimeout    time.Duration
	SessionAbsoluteTTL    time.Duration
	SessionLimit          int
	UpstreamTimeout       time.Duration
	UpstreamMaxBytes      int64
	ArtworkMaxBytes       int64
	CacheEntries          int
	CacheMaxBytes         int64
	CategoryCacheTTL      time.Duration
	ChannelCacheTTL       time.Duration
	EPGCacheTTL           time.Duration
	ArtworkCacheTTL       time.Duration
	CatalogCacheTTL       time.Duration
	DetailCacheTTL        time.Duration
	DiagnosticCacheTTL    time.Duration
	VLCSessionLimit       int
	LoginAccountRateLimit int
	LoginRateLimit        int
	LoginRateWindow       time.Duration
	LoginRateLimitPeers   int
}

func Load() (Config, error) {
	rawURL := strings.TrimSpace(os.Getenv("DISPATCHARR_URL"))
	if rawURL == "" {
		return Config{}, fmt.Errorf("DISPATCHARR_URL is required")
	}

	dispatcharrURL, err := url.Parse(rawURL)
	if err != nil {
		return Config{}, fmt.Errorf("parse DISPATCHARR_URL: %w", err)
	}
	if dispatcharrURL.Scheme != "http" && dispatcharrURL.Scheme != "https" {
		return Config{}, fmt.Errorf("DISPATCHARR_URL must use http or https")
	}
	if dispatcharrURL.Host == "" {
		return Config{}, fmt.Errorf("DISPATCHARR_URL must include a host")
	}
	if dispatcharrURL.User != nil || dispatcharrURL.RawQuery != "" || dispatcharrURL.Fragment != "" {
		return Config{}, fmt.Errorf("DISPATCHARR_URL must not include credentials, a query, or a fragment")
	}
	dispatcharrURL.Path = strings.TrimRight(dispatcharrURL.Path, "/")

	cfg := Config{
		ProgramSearchEnabled:  envBool("NOW_PROGRAM_SEARCH_ENABLED", true),
		ListenAddress:         envString("NOW_LISTEN_ADDRESS", defaultListenAddress),
		DispatcharrURL:        dispatcharrURL,
		WebRoot:               envString("NOW_WEB_ROOT", "web"),
		CookieSecure:          strings.ToLower(envString("NOW_COOKIE_SECURE", "auto")),
		TrustProxyHeaders:     envBool("NOW_TRUST_PROXY_HEADERS", false),
		SessionIdleTimeout:    envDuration("NOW_SESSION_IDLE_TIMEOUT", defaultSessionIdle),
		SessionAbsoluteTTL:    envDuration("NOW_SESSION_ABSOLUTE_TIMEOUT", defaultSessionAbsolute),
		SessionLimit:          envInt("NOW_SESSION_LIMIT", 512),
		UpstreamTimeout:       envDuration("NOW_UPSTREAM_TIMEOUT", defaultUpstreamTimeout),
		UpstreamMaxBytes:      int64(envInt("NOW_UPSTREAM_MAX_MIB", 32)) * 1024 * 1024,
		ArtworkMaxBytes:       int64(envInt("NOW_ARTWORK_MAX_MIB", 2)) * 1024 * 1024,
		CacheEntries:          envInt("NOW_CACHE_ENTRIES", 128),
		CacheMaxBytes:         int64(envInt("NOW_CACHE_MAX_MIB", 32)) * 1024 * 1024,
		CategoryCacheTTL:      envDuration("NOW_CATEGORY_CACHE_TTL", defaultCategoryCacheTTL),
		ChannelCacheTTL:       envDuration("NOW_CHANNEL_CACHE_TTL", defaultChannelCacheTTL),
		EPGCacheTTL:           envDuration("NOW_EPG_CACHE_TTL", defaultEPGCacheTTL),
		ArtworkCacheTTL:       envDuration("NOW_ARTWORK_CACHE_TTL", defaultArtworkCacheTTL),
		CatalogCacheTTL:       envDuration("NOW_CATALOG_CACHE_TTL", defaultCatalogCacheTTL),
		DetailCacheTTL:        envDuration("NOW_DETAIL_CACHE_TTL", defaultDetailCacheTTL),
		DiagnosticCacheTTL:    envDuration("NOW_DIAGNOSTIC_CACHE_TTL", defaultDiagnosticCacheTT),
		VLCSessionLimit:       envInt("NOW_VLC_SESSION_LIMIT", 1024),
		LoginAccountRateLimit: envInt("NOW_LOGIN_ACCOUNT_RATE_LIMIT", 30),
		LoginRateLimit:        envInt("NOW_LOGIN_RATE_LIMIT", 10),
		LoginRateWindow:       envDuration("NOW_LOGIN_RATE_WINDOW", 5*time.Minute),
		LoginRateLimitPeers:   envInt("NOW_LOGIN_RATE_PEERS", 4096),
	}

	if cfg.CookieSecure != "auto" && cfg.CookieSecure != "true" && cfg.CookieSecure != "false" {
		return Config{}, fmt.Errorf("NOW_COOKIE_SECURE must be auto, true, or false")
	}
	if cfg.SessionIdleTimeout <= 0 || cfg.SessionAbsoluteTTL <= 0 {
		return Config{}, fmt.Errorf("session timeouts must be positive")
	}
	if cfg.SessionIdleTimeout > cfg.SessionAbsoluteTTL {
		return Config{}, fmt.Errorf("idle session timeout cannot exceed absolute timeout")
	}
	if cfg.SessionLimit < 1 || cfg.VLCSessionLimit < 1 || cfg.CacheEntries < 1 || cfg.CacheMaxBytes < 1 || cfg.UpstreamMaxBytes < 1 || cfg.ArtworkMaxBytes < 1 {
		return Config{}, fmt.Errorf("session and cache limits must be positive")
	}
	if cfg.CategoryCacheTTL <= 0 || cfg.ChannelCacheTTL <= 0 || cfg.EPGCacheTTL <= 0 || cfg.ArtworkCacheTTL <= 0 || cfg.CatalogCacheTTL <= 0 || cfg.DetailCacheTTL <= 0 || cfg.DiagnosticCacheTTL <= 0 {
		return Config{}, fmt.Errorf("cache lifetimes must be positive")
	}
	if cfg.LoginAccountRateLimit < 1 || cfg.LoginRateLimit < 1 || cfg.LoginRateWindow <= 0 || cfg.LoginRateLimitPeers < 1 {
		return Config{}, fmt.Errorf("login rate limits must be positive")
	}

	return cfg, nil
}

func envString(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func envBool(name string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envInt(name string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envDuration(name string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}
