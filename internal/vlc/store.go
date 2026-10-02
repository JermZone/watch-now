// Package vlc stores short-lived, opaque VLC handoff tickets and media
// authorizations. It intentionally keeps all state in memory: process restart
// invalidates every outstanding handoff.
package vlc

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"sync"
	"time"
)

const (
	// HandshakeTTL is the window in which VLC may follow (or repeat) a launch
	// URL before it must be treated as unknown.
	HandshakeTTL = 60 * time.Second
	// MediaIdleTTL is the rolling idle lifetime granted by a successful media
	// lookup.
	MediaIdleTTL = 10 * time.Minute
	// MediaMaxLifetime is the non-extendable lifetime of a media authorization.
	MediaMaxLifetime = 6 * time.Hour
	// Limit one viewer from exhausting the global handoff pool. A household
	// viewer can still keep several concurrent VLC requests or retries alive.
	maxHandoffsPerSession = 8
	maxRelaysPerMedia     = 4

	tokenBytes       = 32
	maxTokenAttempts = 8
)

var (
	ErrCapacity     = errors.New("vlc handoff capacity reached")
	ErrInvalidInput = errors.New("invalid vlc handoff input")
	ErrToken        = errors.New("could not create unique vlc handoff token")
)

// ContentKind identifies the XC media endpoint authorized for a handoff.
type ContentKind string

const (
	KindLive    ContentKind = "live"
	KindMovie   ContentKind = "movie"
	KindEpisode ContentKind = "episode"
)

// CreateParams is the authorization snapshot captured by an authenticated
// browser action. StreamID and Extension must already have been resolved from
// viewer-authorized catalog data; no client-supplied upstream URL is stored.
type CreateParams struct {
	SessionID       string
	Kind            ContentKind
	ContentID       string
	ParentSeriesID  string
	StreamID        string
	Extension       string
	DisplayFilename string
	BaseURL         string
}

// Created identifies both opaque stages of a newly-created handoff.
type Created struct {
	TicketID        string
	MediaID         string
	TicketExpiresAt time.Time
	MediaExpiresAt  time.Time
	HardExpiresAt   time.Time
}

// Media is the server-side authorization resolved from an opaque media ID.
// ExpiresAt is its current rolling idle deadline; HardExpiresAt never changes.
type Media struct {
	ID              string
	SessionID       string
	Kind            ContentKind
	ContentID       string
	ParentSeriesID  string
	StreamID        string
	Extension       string
	DisplayFilename string
	BaseURL         string
	CreatedAt       time.Time
	ExpiresAt       time.Time
	HardExpiresAt   time.Time
	revoked         chan struct{}
	activeRelays    int
}

// Revoked closes when logout, expiration, or fail-closed binding validation
// removes this authorization. Active relays can use it for prompt teardown.
func (media Media) Revoked() <-chan struct{} { return media.revoked }

// StoreStats reports current live state after opportunistic expiry cleanup.
// Limit is the maximum number of simultaneous media handoffs. At most one
// launch ticket exists for each media handoff.
type StoreStats struct {
	Tickets int
	Media   int
	Limit   int
}

type ticketRecord struct {
	mediaID   string
	sessionID string
	kind      ContentKind
	contentID string
	expiresAt time.Time
}

// Store is a concurrency-safe, bounded in-memory VLC authorization store.
// The limit applies to simultaneous media handoffs; consequently both the
// media map and ticket map are independently bounded by limit.
type Store struct {
	mu      sync.Mutex
	tickets map[string]ticketRecord
	media   map[string]Media
	limit   int
	now     func() time.Time
	token   func() (string, error)
}

// NewStore creates a fail-closed store. A non-positive limit creates a valid
// store that rejects every Create call with ErrCapacity.
func NewStore(limit int) *Store {
	if limit < 0 {
		limit = 0
	}
	return &Store{
		tickets: make(map[string]ticketRecord),
		media:   make(map[string]Media),
		limit:   limit,
		now:     time.Now,
		token:   randomToken,
	}
}

// Create atomically allocates one repeatable launch ticket and its bound media
// authorization. Capacity and token-generation failures leave no partial state.
func (s *Store) Create(params CreateParams) (Created, error) {
	if !validParams(params) {
		return Created{}, ErrInvalidInput
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	s.removeExpiredLocked(now)
	if len(s.media) >= s.limit {
		return Created{}, ErrCapacity
	}
	owned := 0
	for _, item := range s.media {
		if item.SessionID == params.SessionID {
			owned++
		}
	}
	if owned >= maxHandoffsPerSession {
		return Created{}, ErrCapacity
	}

	mediaID, err := s.uniqueTokenLocked("")
	if err != nil {
		return Created{}, err
	}
	ticketID, err := s.uniqueTokenLocked(mediaID)
	if err != nil {
		return Created{}, err
	}

	ticketExpiresAt := now.Add(HandshakeTTL)
	hardExpiresAt := now.Add(MediaMaxLifetime)
	mediaExpiresAt := earlier(ticketExpiresAt, hardExpiresAt)
	revoked := make(chan struct{})
	item := Media{
		ID:              mediaID,
		SessionID:       params.SessionID,
		Kind:            params.Kind,
		ContentID:       params.ContentID,
		ParentSeriesID:  params.ParentSeriesID,
		StreamID:        params.StreamID,
		Extension:       params.Extension,
		DisplayFilename: params.DisplayFilename,
		BaseURL:         params.BaseURL,
		CreatedAt:       now,
		ExpiresAt:       mediaExpiresAt,
		HardExpiresAt:   hardExpiresAt,
		revoked:         revoked,
	}
	s.media[mediaID] = item
	s.tickets[ticketID] = ticketRecord{
		mediaID:   mediaID,
		sessionID: params.SessionID,
		kind:      params.Kind,
		contentID: params.ContentID,
		expiresAt: ticketExpiresAt,
	}

	return Created{
		TicketID:        ticketID,
		MediaID:         mediaID,
		TicketExpiresAt: ticketExpiresAt,
		MediaExpiresAt:  mediaExpiresAt,
		HardExpiresAt:   hardExpiresAt,
	}, nil
}

// RedeemTicket resolves a launch ticket without consuming it or extending any
// deadline. Repeated launches therefore resolve to the same media ID during the
// original 60-second handshake window.
func (s *Store) RedeemTicket(ticketID string) (Media, bool) {
	if !validToken(ticketID) {
		return Media{}, false
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	s.removeExpiredLocked(now)
	ticket, ok := s.tickets[ticketID]
	if !ok {
		return Media{}, false
	}
	item, ok := s.media[ticket.mediaID]
	if !ok || !ticketMatchesMedia(ticket, item) {
		delete(s.tickets, ticketID)
		if ok {
			s.removeMediaLocked(item.ID)
		}
		return Media{}, false
	}
	return item, true
}

// ResolveMedia resolves an opaque media ID. When touch is true, its rolling
// idle deadline is extended to ten minutes from now, but never shortened and
// never extended past the fixed six-hour hard deadline.
func (s *Store) ResolveMedia(mediaID string, touch bool) (Media, bool) {
	if !validToken(mediaID) {
		return Media{}, false
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	s.removeExpiredLocked(now)
	item, ok := s.media[mediaID]
	if !ok {
		return Media{}, false
	}
	if touch {
		nextExpiry := earlier(now.Add(MediaIdleTTL), item.HardExpiresAt)
		if nextExpiry.After(item.ExpiresAt) {
			item.ExpiresAt = nextExpiry
			s.media[mediaID] = item
		}
	}
	return item, true
}

// BeginRelay reserves one of a media token's small number of concurrent relay
// slots and touches its idle deadline. The returned release must be called.
func (s *Store) BeginRelay(mediaID string) (Media, func(), bool) {
	if !validToken(mediaID) {
		return Media{}, nil, false
	}

	s.mu.Lock()
	now := s.now()
	s.removeExpiredLocked(now)
	item, ok := s.media[mediaID]
	if !ok || item.activeRelays >= maxRelaysPerMedia {
		s.mu.Unlock()
		return Media{}, nil, false
	}
	item.ExpiresAt = earlier(now.Add(MediaIdleTTL), item.HardExpiresAt)
	item.activeRelays++
	s.media[mediaID] = item
	revoked := item.revoked
	s.mu.Unlock()

	release := func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		current, exists := s.media[mediaID]
		if exists && current.revoked == revoked && current.activeRelays > 0 {
			current.activeRelays--
			s.media[mediaID] = current
		}
	}
	return item, release, true
}

// DeleteSession revokes every launch ticket and media authorization owned by a
// viewer session, for example during logout or session destruction.
func (s *Store) DeleteSession(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.removeExpiredLocked(s.now())
	for id, item := range s.media {
		if item.SessionID == sessionID {
			s.removeMediaLocked(id)
		}
	}
	for id, ticket := range s.tickets {
		if ticket.sessionID == sessionID {
			delete(s.tickets, id)
		}
	}
}

// Stats returns live counts after opportunistically removing expired state.
func (s *Store) Stats() StoreStats {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.removeExpiredLocked(s.now())
	return StoreStats{
		Tickets: len(s.tickets),
		Media:   len(s.media),
		Limit:   s.limit,
	}
}

func (s *Store) removeExpiredLocked(now time.Time) {
	for id, item := range s.media {
		if expired(now, item.ExpiresAt) || expired(now, item.HardExpiresAt) {
			s.removeMediaLocked(id)
		}
	}
	for id, ticket := range s.tickets {
		item, ok := s.media[ticket.mediaID]
		if ok && !ticketMatchesMedia(ticket, item) {
			s.removeMediaLocked(ticket.mediaID)
			continue
		}
		if expired(now, ticket.expiresAt) || !ok {
			delete(s.tickets, id)
		}
	}
}

func (s *Store) removeMediaLocked(mediaID string) {
	item, ok := s.media[mediaID]
	if ok {
		close(item.revoked)
	}
	delete(s.media, mediaID)
	for id, ticket := range s.tickets {
		if ticket.mediaID == mediaID {
			delete(s.tickets, id)
		}
	}
}

func (s *Store) uniqueTokenLocked(exclude string) (string, error) {
	for range maxTokenAttempts {
		token, err := s.token()
		if err != nil {
			return "", err
		}
		if !validToken(token) || token == exclude {
			continue
		}
		if _, exists := s.tickets[token]; exists {
			continue
		}
		if _, exists := s.media[token]; exists {
			continue
		}
		return token, nil
	}
	return "", ErrToken
}

func validParams(params CreateParams) bool {
	return params.SessionID != "" &&
		(params.Kind == KindLive || params.Kind == KindMovie || params.Kind == KindEpisode) &&
		params.ContentID != "" &&
		params.StreamID != "" &&
		params.Extension != ""
}

func ticketMatchesMedia(ticket ticketRecord, item Media) bool {
	return ticket.mediaID == item.ID &&
		ticket.sessionID == item.SessionID &&
		ticket.kind == item.Kind &&
		ticket.contentID == item.ContentID
}

func expired(now, deadline time.Time) bool {
	return !now.Before(deadline)
}

func earlier(left, right time.Time) time.Time {
	if left.Before(right) {
		return left
	}
	return right
}

func validToken(token string) bool {
	if len(token) != base64.RawURLEncoding.EncodedLen(tokenBytes) {
		return false
	}
	for _, character := range token {
		if (character >= 'A' && character <= 'Z') ||
			(character >= 'a' && character <= 'z') ||
			(character >= '0' && character <= '9') ||
			character == '-' || character == '_' {
			continue
		}
		return false
	}
	return true
}

func randomToken() (string, error) {
	buffer := make([]byte, tokenBytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}
