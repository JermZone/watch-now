package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/JermZone/watch-now/internal/config"
	"github.com/JermZone/watch-now/internal/dispatcharr"
	"github.com/JermZone/watch-now/internal/httpapi"
)

var version = "dev"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		healthcheck()
		return
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.Load()
	if err != nil {
		logger.Error("configuration error", "error", err)
		os.Exit(1)
	}

	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		MaxIdleConns:          32,
		MaxIdleConnsPerHost:   16,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: cfg.UpstreamTimeout,
	}
	upstreamHTTP := &http.Client{Transport: transport, Timeout: cfg.UpstreamTimeout}
	dispatcharrClient := dispatcharr.NewClient(cfg.DispatcharrURL, upstreamHTTP, cfg.UpstreamMaxBytes, cfg.ArtworkMaxBytes)

	diagnosticContext, cancelDiagnostic := context.WithTimeout(context.Background(), min(3*time.Second, cfg.UpstreamTimeout))
	diagnostics := dispatcharrClient.Diagnostics(diagnosticContext)
	cancelDiagnostic()
	if diagnostics.Reachable {
		logger.Info("Dispatcharr reachable", "version", diagnostics.Version, "reported_at", diagnostics.Timestamp)
	} else {
		logger.Warn("Dispatcharr diagnostics unavailable; Now will still validate XC capabilities at login", "reason", diagnostics.Error)
	}

	server := &http.Server{
		Addr:              cfg.ListenAddress,
		Handler:           httpapi.New(cfg, dispatcharrClient, logger),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	shutdownSignals, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	go func() {
		<-shutdownSignals.Done()
		shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownContext); err != nil {
			logger.Error("graceful shutdown failed", "error", err)
		}
	}()

	logger.Info("Watch Now started", "address", cfg.ListenAddress, "version", version)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Error("server stopped unexpectedly", "error", err)
		os.Exit(1)
	}
	logger.Info("Watch Now stopped")
}

func healthcheck() {
	endpoint := os.Getenv("NOW_HEALTHCHECK_URL")
	if endpoint == "" {
		endpoint = "http://127.0.0.1:8080/api/health/live"
	}
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get(endpoint)
	if err != nil {
		fmt.Fprintln(os.Stderr, "healthcheck failed")
		os.Exit(1)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "healthcheck failed")
		os.Exit(1)
	}
}
