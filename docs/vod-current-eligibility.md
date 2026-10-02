# Movie and Series access after cache changes

Movie/Series catalogs remain cached for display. Opening details, retrying episodes, browser media/download requests, and VLC handoff/media requests use fresh item-specific XC details. Completed detail responses are never reused as permission decisions or episode lists; only overlapping same-session/item requests share a lookup. Removed episodes are checked against the current Series response.

Posters use a fresh XC listing, scoped to the item's displayed category when known. A cached category is only a hint; the returned current list must still contain the requested ID. If there is no category hint, the bounded full listing is used. Listings share only overlapping same-session/category requests, under the existing 16-lookup concurrency limit. No provider-detail request is added for passive poster browsing. Oversized/unavailable listings fail closed; a moved item may temporarily show a placeholder until its displayed listing is refreshed.

Server-side image bytes remain cached, but every image response rechecks access. Poster responses use `private, no-store` so new browser requests reach that check. Already-rendered content cannot be recalled from a device. Latest item metadata may remain in the bounded private cache solely to supply a poster source or media-extension fallback after a fresh access check; it is not an authorization source.

Stock XC details may refresh stale Movie/Series metadata and episode links in Dispatcharr. This behavior remains; the fix does not claim no-refresh item access or change Dispatcharr internals. Image authorization uses listing calls to avoid per-poster metadata refreshes. Very large categories can still exceed the existing 32 MiB response limit, which is unchanged.

Validate these boundaries using synthetic HTTP/XC fixtures and an isolated stock Dispatcharr stack. Do not use production accounts or metadata for destructive tests. Follow the [release checklist](release-readiness.md).
