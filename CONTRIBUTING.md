# Contributing to Watch Now

Bug reports and focused pull requests are welcome. Read [Support](SUPPORT.md) for
safe diagnostic details and [Security](SECURITY.md) for private reports.

Keep Watch Now a lightweight viewer: no provider management, database, transcoder,
or access to Dispatcharr internals. See [AGENTS.md](AGENTS.md) for boundaries.

Use the Go and Node versions pinned in the Dockerfile and CI. Run:

```sh
npm ci --prefix frontend
make test
npm run build --prefix frontend
go test -race ./...
python3 scripts/test-compose.py
make docker-build
git diff --check
```

Use synthetic fixtures, not personal accounts or provider credentials. Include a
regression test for behavior changes and describe any checks not performed.
Screenshots must use sample data and be actual captures, not edited mockups.

Contributions are licensed under the existing AGPLv3 license. Retain original
copyright and third-party notices. The initial public snapshot does not erase
attribution; see [PROVENANCE.md](PROVENANCE.md).
