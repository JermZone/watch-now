package cache

import (
	"container/list"
	"strings"
	"sync"
	"time"
)

type entry struct {
	key       string
	value     any
	size      int64
	expiresAt time.Time
}

type Cache struct {
	mu         sync.Mutex
	items      map[string]*list.Element
	lru        *list.List
	maxEntries int
	maxBytes   int64
	usedBytes  int64
	now        func() time.Time
}

func New(maxEntries int, maxBytes int64) *Cache {
	return &Cache{
		items:      make(map[string]*list.Element),
		lru:        list.New(),
		maxEntries: maxEntries,
		maxBytes:   maxBytes,
		now:        time.Now,
	}
}

func (c *Cache) Get(key string) (any, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	element, ok := c.items[key]
	if !ok {
		return nil, false
	}
	item := element.Value.(*entry)
	if !c.now().Before(item.expiresAt) {
		c.remove(element)
		return nil, false
	}
	c.lru.MoveToFront(element)
	return item.value, true
}

func (c *Cache) Set(key string, value any, size int64, ttl time.Duration) {
	if size < 0 || size > c.maxBytes || ttl <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if existing, ok := c.items[key]; ok {
		c.remove(existing)
	}
	item := &entry{key: key, value: value, size: size, expiresAt: c.now().Add(ttl)}
	element := c.lru.PushFront(item)
	c.items[key] = element
	c.usedBytes += size
	for len(c.items) > c.maxEntries || c.usedBytes > c.maxBytes {
		c.remove(c.lru.Back())
	}
}

func (c *Cache) DeletePrefix(prefix string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, element := range c.items {
		if strings.HasPrefix(key, prefix) {
			c.remove(element)
		}
	}
}

func (c *Cache) Stats() (entries int, bytes int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.items), c.usedBytes
}

func (c *Cache) remove(element *list.Element) {
	if element == nil {
		return
	}
	item := element.Value.(*entry)
	delete(c.items, item.key)
	c.usedBytes -= item.size
	c.lru.Remove(element)
}
