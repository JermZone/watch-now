# Security policy

Report vulnerabilities privately using [GitHub private vulnerability reporting](https://github.com/JermZone/watch-now/security/advisories/new).
If that option is unavailable, open an issue requesting a private reporting channel
without describing the vulnerability. Do not put credentials or token URLs in public issues.

The latest released 1.x version receives security fixes. Older patch versions should
be updated. There is no guaranteed response-time SLA for this volunteer project.
Include the version, deployment method, impact, and a minimal sanitized reproduction.

Reusable XC credentials stay in server memory; restarts invalidate viewer sessions.
Deploy over HTTPS outside a trusted LAN. See docs/public-hosting.md for proxy trust,
logging, stream links, rate limits, and resource controls. The service does not
transcode media or provide its own accounts, MFA, or provider permissions.
