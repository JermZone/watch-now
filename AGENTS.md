# Watch Now standalone working instructions

## Product boundary

Watch Now is a lightweight viewer companion for a stock Dispatcharr installation. It communicates with Dispatcharr only through supported HTTP/XC interfaces and must not access Dispatcharr's database, Redis, filesystem, Docker socket, or Python internals.

Keep the default deployment to one non-root Go process in one container. Do not add PostgreSQL, Redis, Celery, Django, nginx, FFmpeg, persistent sessions, or persistent catalog storage without explicit approval and evidence that the lightweight design cannot meet the requirement.

## Compatibility

Dispatcharr v0.31 is the initial validated baseline, not a version whitelist. Treat `/api/core/version/` as diagnostic metadata. Validate the specific XC capabilities and response fields used by the application, tolerate unknown fields, and do not reject a newer version solely because of its version number.

## Security

- Never send XC credentials to the browser.
- Never log full Dispatcharr URLs, query strings, request bodies, credentials, cookies, CSRF tokens, or upstream response bodies.
- Keep viewer-facing response models narrow and Now-owned.
- Preserve HttpOnly/SameSite session cookies, origin validation, CSRF validation, rate limits, and bounded memory use.
- Keep sessions and caches process-local unless persistent or distributed state is explicitly approved.

## Workflow

- Inspect before changing code.
- Keep changes focused on the documented Live TV, Movies, and Series viewer scope. Keep unrelated dependency upgrades and playback fixes in separate reviewed changes.
- Add or update tests for changed behavior.
- Run `go test ./...`, `go vet ./...`, `npm test`, `npm run build`, and `git diff --check` before handoff.
- Build the Docker image when a Docker daemon is available.
- Do not commit or push unless explicitly instructed.
