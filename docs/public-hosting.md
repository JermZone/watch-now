# Hosting on the internet

Keep Dispatcharr private. Expose only Watch Now through an HTTPS reverse proxy.
The proxy must reach the app, and the app must reach Dispatcharr. Native VLC must
also reach the public app hostname; a browser-only authentication gate can block it.

Set these app environment variables for a trusted proxy deployment:

```dotenv
NOW_COOKIE_SECURE=true
NOW_TRUST_PROXY_HEADERS=true
NOW_HOST_BIND=127.0.0.1
```

The included [nginx example](../deploy/nginx.conf) is for nginx installed on the
same host as Docker. Replace the hostname and certificate paths, obtain a valid
certificate using your normal ACME tooling, and run `nginx -t` before reloading.
Only forward ports 80/443 on the router. Never forward the app port or Dispatcharr's
management port. Keep certificate renewal enabled and test it.

For a container proxy, attach both services to a dedicated Docker network, use
`watch-now:8080` as the upstream, and remove the app's `ports` mapping.
Do not use `127.0.0.1` to reach another container. Do not enable trusted proxy headers
when clients can bypass the proxy. The example **replaces** forwarded Host, Proto,
and For headers rather than appending untrusted client input.

## Limits and credentials

The default stack caps the process at 256 MiB and 100 PIDs. CPU quotas are optional
because some Synology kernels do not support them; add `cpus: 1.0` only on hosts
with CPU quota support. Sessions and
caches have bounded sizes and expire in memory. These are starting limits, not a
capacity guarantee. Watch memory and upstream traffic during real usage and set
per-viewer stream limits in Dispatcharr. Streams consume bandwidth even if no
transcoding runs. Restarting Watch Now invalidates browser sessions and VLC media links.

Login has an IP limit (10 attempts per 5 minutes) and an account limit (30 attempts
per 5 minutes across addresses). Both use bounded in-memory maps; restarting clears
them. The proxy adds connection and login-request limits. Account throttling can
temporarily affect legitimate users under attack; it does not replace strong
passwords or upstream access restrictions.

VLC media links are bearer credentials: anyone with the link can use it until expiry.
Do not share playlists or paste their contents into issues. Launch links last one
minute. Media links expire after ten minutes without a media request and have an
absolute six-hour limit. A downloaded playlist should be opened promptly; generate
a new one if it expires. A player may buffer data before Dispatcharr stops reporting
activity; that alone does not prove playback stopped.

## Logs and verification

The nginx example logs method, status, bytes, and timing without request paths or
queries. Keep that policy at every proxy/CDN layer. Dispatcharr's own upstream logs
may contain XC credentials in request paths/queries: restrict, redact, and rotate
those logs. Do not send raw logs to public support channels.

Before public exposure verify:

- Anonymous visitors see sign-in and cannot read catalogs or detailed diagnostics.
- HTTPS login sets an HttpOnly, Secure, SameSite=Strict cookie; HTTP redirects to HTTPS.
- Direct access to the backend port is blocked from outside the proxy.
- A restricted viewer sees and plays only its assigned channels.
- Logout/restart revokes browser access; rate limits return 429 with Retry-After.
- Browser playback, downloads, and VLC launch work through the actual public URL.
- Certificate renewal, app updates, and rollback have been tested.

The repository configuration can be validated locally; the actual public hostname,
router/firewall rules, and certificate must still be checked on the deployment host.
