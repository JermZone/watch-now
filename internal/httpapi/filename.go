package httpapi

import (
	"fmt"
	"regexp"
	"strings"
)

var unsafeFilenameCharacters = regexp.MustCompile(`[^A-Za-z0-9._ -]+`)

func sanitizeDownloadBase(value, fallback string) string {
	value = unsafeFilenameCharacters.ReplaceAllString(value, "_")
	value = strings.Trim(value, " .")
	if value == "" {
		value = fallback
	}
	// Keep Content-Disposition comfortably below common proxy header limits.
	if len(value) > 180 {
		value = strings.TrimRight(value[:180], " .")
	}
	if value == "" {
		return fallback
	}
	return value
}

func movieDownloadFilename(title string) string {
	return sanitizeDownloadBase(title, "movie")
}

func episodeDownloadFilename(seriesTitle string, seasonNumber, episodeNumber int, episodeTitle string) string {
	// Bound both provider-controlled values before quoting/compiling a dynamic
	// expression. This also normalizes them consistently for prefix de-duplication.
	seriesTitle = sanitizeDownloadBase(strings.TrimSpace(seriesTitle), "Series")
	episodeTitle = sanitizeDownloadBase(strings.TrimSpace(episodeTitle), "Episode")
	episodeID := fmt.Sprintf("S%02dE%02d", max(0, seasonNumber), max(0, episodeNumber))
	prefix := regexp.MustCompile(
		`(?i)^` + regexp.QuoteMeta(seriesTitle) +
			`([ \t]+-[ \t]+|[ \t]+)` + regexp.QuoteMeta(episodeID) +
			`(([ \t]*-[ \t]*|[ \t]+)(.*))?$`,
	)
	if match := prefix.FindStringSubmatch(episodeTitle); match != nil {
		episodeTitle = strings.TrimSpace(match[4])
		if episodeTitle == "" {
			episodeTitle = "Episode"
		}
	}
	return sanitizeDownloadBase(
		fmt.Sprintf("%s - %s - %s", seriesTitle, episodeID, episodeTitle),
		"Series - S00E00 - Episode",
	)
}
