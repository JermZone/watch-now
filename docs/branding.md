# Watch Now branding

**Watch Now**
*A web player for Dispatcharr.*

This is an independent open-source viewer, not an official Dispatcharr application.
Use Dispatcharr's name only for the upstream server, configuration, and compatibility.
Do not claim that its team audited, endorsed, or guarantees this project.

The prepared source uses `watch-now` for the executable, Go module, frontend package,
new Compose service, image repository, and future release archives. The runtime
`NOW_*`/`DISPATCHARR_*` settings and default ports remain unchanged.

Existing browser preference keys and the session-cookie identifier are deliberately
retained as internal compatibility details. They are not public branding. Cookies
contain only the opaque session token, not upstream credentials. Restarts still end
sessions; a retained cookie name does not preserve a server-side session.

Follow [migration](migration.md) before touching a development installation.
