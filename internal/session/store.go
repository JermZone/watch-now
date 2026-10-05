package session

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"sync"
	"time"

	"github.com/JermZone/watch-now/internal/dispatcharr"
)

var ErrCapacity = errors.New("session capacity reached")

type Session struct {
	DVRKey         string `json:"-"`
	ID             string
	CSRFToken      string
	Credentials    dispatcharr.Credentials
	Username       string
	CreatedAt      time.Time
	LastSeenAt     time.Time
	playbackActive bool
}

// BeginPlayback marks a session as actively streaming. Active playback counts
// as session activity for idle-expiration purposes, but never extends the
// absolute lifetime.
func (s *Store) BeginPlayback(id string) (Session, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	entry, ok := s.sessions[id]
	if !ok {
		return Session{}, false
	}
	now := s.now()
	if s.expired(entry, now) {
		delete(s.sessions, id)
		return Session{}, false
	}
	entry.LastSeenAt = now
	entry.playbackActive = true
	s.sessions[id] = entry
	return entry, true
}

// EndPlayback resumes normal idle expiration from the moment the currently
// owned playback ends. It is intentionally a no-op for an already removed
// session, such as after logout or absolute expiration.
func (s *Store) EndPlayback(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	entry, ok := s.sessions[id]
	if !ok {
		return
	}
	now := s.now()
	if s.absoluteExpired(entry, now) {
		delete(s.sessions, id)
		return
	}
	entry.LastSeenAt = now
	entry.playbackActive = false
	s.sessions[id] = entry
}

type Store struct {
	mu          sync.Mutex
	sessions    map[string]Session
	idleTTL     time.Duration
	absoluteTTL time.Duration
	limit       int
	now         func() time.Time
}

func NewStore(idleTTL, absoluteTTL time.Duration, limit int) *Store {
	return &Store{
		sessions:    make(map[string]Session),
		idleTTL:     idleTTL,
		absoluteTTL: absoluteTTL,
		limit:       limit,
		now:         time.Now,
	}
}

func (s *Store) Create(credentials dispatcharr.Credentials, username string) (Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	s.removeExpired(now)
	if len(s.sessions) >= s.limit {
		return Session{}, ErrCapacity
	}

	id, err := randomToken()
	if err != nil {
		return Session{}, err
	}
	csrf, err := randomToken()
	if err != nil {
		return Session{}, err
	}
	entry := Session{
		ID:          id,
		CSRFToken:   csrf,
		Credentials: credentials,
		Username:    username,
		CreatedAt:   now,
		LastSeenAt:  now,
	}
	s.sessions[id] = entry
	return entry, nil
}

func (s *Store) Get(id string) (Session, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	entry, ok := s.sessions[id]
	if !ok {
		return Session{}, false
	}
	now := s.now()
	if s.expired(entry, now) {
		delete(s.sessions, id)
		return Session{}, false
	}
	entry.LastSeenAt = now
	s.sessions[id] = entry
	return entry, true
}

func (s *Store) Delete(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, id)
}

func (s *Store) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.removeExpired(s.now())
	return len(s.sessions)
}

func (s *Store) expired(entry Session, now time.Time) bool {
	return s.absoluteExpired(entry, now) || (!entry.playbackActive && now.Sub(entry.LastSeenAt) > s.idleTTL)
}

func (s *Store) absoluteExpired(entry Session, now time.Time) bool {
	return now.Sub(entry.CreatedAt) > s.absoluteTTL
}

func (s *Store) removeExpired(now time.Time) {
	for id, entry := range s.sessions {
		if s.expired(entry, now) {
			delete(s.sessions, id)
		}
	}
}

func randomToken() (string, error) {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

// SetDVRKey never resurrects a logged-out or expired session. Compare-and-swap
// prevents a failed old request from clearing a newly connected credential.
func (s *Store) SetDVRKey(id, expected, key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.sessions[id]
	if !ok {
		return false
	}
	if s.expired(entry, s.now()) {
		delete(s.sessions, id)
		return false
	}
	if entry.DVRKey != expected {
		return false
	}
	entry.DVRKey = key
	s.sessions[id] = entry
	return true
}
