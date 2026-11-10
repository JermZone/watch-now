package dispatcharr

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestJSONBudgetsBeforeDecode(t *testing.T) {
	for name, data := range map[string]string{
		"array":         "[" + strings.Repeat("0,", 20000) + "0]",
		"depth":         strings.Repeat("[", 17) + "0" + strings.Repeat("]", 17),
		"field":         `{"name":"` + strings.Repeat("x", 65537) + `"}`,
		"members":       "{" + strings.Repeat(`"k":0,`, 128) + `"z":0}`,
		"total strings": "[" + strings.Repeat(`"`+strings.Repeat("x", 64000)+`",`, 66) + `""]`,
		"nodes":         "[" + strings.Repeat("["+strings.Repeat("0,", 19999)+"0],", 13) + "[]]",
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateJSONBudget([]byte(data), 20000); !errors.Is(err, ErrResponseTooBig) {
				t.Fatalf("got %v", err)
			}
		})
	}
	if err := validateJSONBudget([]byte(`{"unknown":{"future":true},"items":[{},null,12,"quoted\"text"]}`), 20000); err != nil {
		t.Fatal(err)
	}
	if err := validateJSONBudget([]byte(`{"bad":}`), 20000); !errors.Is(err, ErrInvalidResponse) {
		t.Fatal(err)
	}
	if err := validateJSONBudget([]byte("["+strings.Repeat("{},", 5000)+"{}]"), 5000); !errors.Is(err, ErrResponseTooBig) {
		t.Fatal(err)
	}
}
func TestJSONClientRejectsBeforeAllocation(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("[" + strings.Repeat("{},", 20000) + "{}]"))
	})
	if _, err := c.LiveCategories(context.Background(), Credentials{}); !errors.Is(err, ErrResponseTooBig) {
		t.Fatal(err)
	}

}
func TestXMLGuideBudgets(t *testing.T) {
	for name, body := range map[string]string{
		"text":      "<tv><programme><desc>" + strings.Repeat("x", 100000) + "</desc></programme></tv>",
		"attribute": `<tv><channel id="` + strings.Repeat("x", 100000) + `"/></tv>`,
		"comment":   "<tv><!--" + strings.Repeat(">", 100000) + "--></tv>",
		"depth":     "<tv>" + strings.Repeat("<x>", 20) + strings.Repeat("</x>", 20) + "</tv>",
		"variants":  "<tv><programme>" + strings.Repeat("<title>x</title>", 300) + "</programme></tv>",
		"channels":  "<tv>" + strings.Repeat(`<channel id="x"/>`, 20001) + "</tv>",
	} {
		t.Run(name, func(t *testing.T) {
			_, err := parseGuide(context.Background(), strings.NewReader(body), nil, time.Now())
			if !errors.Is(err, ErrGuideLimit) {
				t.Fatalf("got %v", err)
			}
		})
	}
	if got := firstGuideText([]string{" \talpha\nβeta " + strings.Repeat("z", 100000)}, 10); got != "alpha βeta" {
		t.Fatalf("got %q", got)
	}
}
func TestArtworkCannotEscapeBasePrefix(t *testing.T) {
	c := testClient(t, func(http.ResponseWriter, *http.Request) {})
	c.baseURL.Path = "/dispatcharr"
	if c.safeArtworkURL("/api/channels/logos/1/cache") != "" {
		t.Fatal("escaped prefix")
	}
	if c.safeArtworkURL("/dispatcharr/api/channels/logos/1/cache") == "" {
		t.Fatal("valid prefix rejected")
	}
}

func TestJSONBudgetCountsItemsAcrossSeasonArrays(t *testing.T) {
	season := "[" + strings.Repeat("{},", 10999) + "{}]"
	body := `{"episodes":{"1":` + season + `,"2":` + season + `}}`
	if err := validateJSONBudget([]byte(body), 20000); !errors.Is(err, ErrResponseTooBig) {
		t.Fatalf("multiple individually-small arrays escaped total item budget: %v", err)
	}
}

func TestXMLStopsReadingInsideOversizedToken(t *testing.T) {
	for name, body := range map[string]string{
		"text":      "<tv><programme><desc>" + strings.Repeat("x", 1<<20) + "</desc></programme></tv>",
		"attribute": `<tv><channel id="` + strings.Repeat("x", 1<<20) + `"/></tv>`,
		"comment":   "<tv><!--" + strings.Repeat("x", 1<<20) + "--></tv>",
	} {
		t.Run(name, func(t *testing.T) {
			reader := strings.NewReader(body)
			_, err := parseGuide(context.Background(), reader, nil, time.Now())
			if !errors.Is(err, ErrGuideLimit) {
				t.Fatalf("got %v", err)
			}
			if consumed := len(body) - reader.Len(); consumed > 70<<10 {
				t.Fatalf("read %d bytes before rejecting a single oversized token", consumed)
			}
		})
	}
}
