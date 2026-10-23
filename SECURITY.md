# Dependency security

## Audit policy

Run `npm run audit:ci` to audit the complete dependency tree, including
development dependencies. Every High and Critical finding fails the check.
`scripts/audit-policy.json` has an empty exception list. Audit command errors,
malformed responses, and incomplete dependency graphs also fail the check.
Moderate findings remain visible under the existing High-or-above gate.

The unfiltered npm response is written to `audit-report.json`. GitHub Actions
uploads it as `npm-audit-report`, including when the audit fails. A passing
policy check does not by itself mean that the raw report has no findings.
`npm audit --omit=dev --json` separately checks production dependencies.

## Removing the braces dependency paths

The old `GHSA-vfj7-8cjw-p6xm` exception expired on **2026-10-21 00:00 JST**.
The proposed renewal in PR #51 is not applied. Instead, the development server
uses official [`webpack-dev-middleware` 8.5.0](https://github.com/webpack/webpack-dev-middleware)
and [`watchpack` 2.5.2](https://github.com/webpack/watchpack), with a small Node.js
HTTP server. This preserves Node.js 20 support (minimum 20.9.0).

The replacement removes both former braces paths:

- `webpack-dev-server -> chokidar -> braces`
- `webpack-dev-server -> http-proxy-middleware -> micromatch -> braces`

The lockfile no longer contains `webpack-dev-server`, `chokidar`,
`http-proxy-middleware`, `micromatch`, or `braces`. The obsolete SockJS UUID
override and SockJS-specific smoke test are removed with SockJS itself.
`http-proxy`, `follow-redirects`, and `launch-editor` also leave the graph.
Removal of these paths is remediation for this repository; it does not claim
that the upstream libraries have been patched. Relevant advisories remain:

- [braces stack exhaustion: GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
- [follow-redirects header escaping: GHSA-8r9p-f939-6h3c](https://github.com/advisories/GHSA-8r9p-f939-6h3c)
- [follow-redirects array headers: GHSA-q3jh-wrc6-jgq8](https://github.com/advisories/GHSA-q3jh-wrc6-jgq8)
- [launch-editor Windows command injection: GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm)

## Development server controls

`npm start` runs `scripts/dev-server.js` with these restrictions:

- Bind only to `127.0.0.1`. The CLI accepts a port and `--no-open`; it offers
  no option to expose a different interface.
- Validate Host against `127.0.0.1:<actual-port>` or
  `localhost:<actual-port>`. When Origin is present, require it to match that
  request's HTTP origin exactly. Reject cross-site and same-site Fetch Metadata
  requests; allow `same-origin`, `none`, or an absent header.
- Apply those checks before serving compiler output, static assets, or the
  live-reload stream. Responses set `Cross-Origin-Resource-Policy: same-origin`
  and `X-Content-Type-Options: nosniff`.
- Use the middleware's built-in SSE client for full-page reloads, with a
  per-run token required on the stream and cross-origin CORS grants disabled.
  Watch source changes through webpack and the fixed `dist` directory through
  Watchpack, with static-watcher symlink following disabled. Request data never
  supplies a watch pattern.
- Serve webpack's in-memory output and regular files under the resolved
  `dist` directory. Reject dotfile/traversal segments, malformed escapes,
  backslashes, and static symlinks resolving outside that directory. There is
  no directory listing, proxy, editor endpoint, or WebSocket transport.

The browser runtime is added only by the development middleware. Production
builds use the ordinary webpack configuration and contain no live-reload
client. Browser opening uses a fixed loopback URL without invoking a shell.

These are local development controls, not an authentication boundary against
other local processes. A local process can send accepted HTTP headers and read
the bundle, including its stream token. Use a trusted checkout and configuration;
do not publish the server through a tunnel or reverse proxy. The implementation
is not a production web server. Linux CI does not establish Windows-specific
exploit behavior or verify every operating system's desktop browser launcher.

## Reproduction

```sh
npm ci --engine-strict
npm run build
npm test
npm run audit:ci
npm audit --omit=dev --json
npm ls webpack-dev-middleware watchpack
```

Use the current unfiltered audit report and CI results for finding counts;
registry advisories can change after a commit is reviewed. Restoring any
removed dependency path must pass the same audit gate without a waiver.
