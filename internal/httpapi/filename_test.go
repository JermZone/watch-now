package httpapi

import (
	"strings"
	"testing"
)

func TestMovieDownloadFilenameIsSafeAndReadable(t *testing.T) {
	if got := movieDownloadFilename("Show Name S01E02/Movie"); got != "Show Name S01E02_Movie" {
		t.Fatalf("movieDownloadFilename() = %q", got)
	}
	if got := movieDownloadFilename("../\r\n"); got != "_" {
		t.Fatalf("unsafe movie filename = %q", got)
	}
}

func TestEpisodeDownloadFilenameBoundsProviderControlledTitles(t *testing.T) {
	got := episodeDownloadFilename(strings.Repeat("Series/", 100_000), 1, 2, strings.Repeat("Episode/", 100_000))
	if len(got) > 180 || strings.ContainsAny(got, "/\\\r\n") {
		t.Fatalf("unsafe or unbounded filename length %d", len(got))
	}
}

func TestEpisodeDownloadFilenameRemovesDuplicatedPrefix(t *testing.T) {
	tests := map[string]string{
		"Pilot":                                  "Example Series - S01E02 - Pilot",
		"Example Series - S01E02 - Pilot":        "Example Series - S01E02 - Pilot",
		"example series S01E02 Pilot":            "Example Series - S01E02 - Pilot",
		"Example Series - S01E02":                "Example Series - S01E02 - Episode",
		"Example Series - S01E02 - Pilot/Part 1": "Example Series - S01E02 - Pilot_Part 1",
	}
	for title, want := range tests {
		if got := episodeDownloadFilename("Example Series", 1, 2, title); got != want {
			t.Errorf("episodeDownloadFilename(%q) = %q, want %q", title, got, want)
		}
	}
}
