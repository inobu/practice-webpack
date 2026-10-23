# practice-webpack

Requires Node.js 24 LTS. Use the latest patched 24.x release.
The `.nvmrc` file selects the same major version locally and in CI.

```sh
nvm install
nvm use
npm ci --engine-strict
npm start
```

The development server opens `http://127.0.0.1:8080` in your browser. Source
changes rebuild the in-memory webpack bundle and reload the page. Changes to
static files under `dist` also reload the page. Stop the server with Ctrl+C.

To choose a port or leave browser opening to you:

```sh
npm start -- --port 8081 --no-open
```

The server listens on IPv4 loopback only. Use the printed `127.0.0.1` URL;
the matching `localhost` Host header is also accepted, but IPv6 is not bound.
It serves compiler output and `dist`, without a proxy or editor endpoint.
Run it in a trusted checkout; see [SECURITY.md](SECURITY.md) for the controls
and their limits.

```sh
npm run build
npm test
npm run audit:ci
```

`build` writes the production bundle to `dist/main.js`. Run it before `test`:
the tests check that bundle, the development server, and the audit policy.
Live reload is development-only and does not enter the production bundle.
`audit:ci` records the unfiltered report in `audit-report.json` and rejects
High and Critical findings; there are no active audit exceptions.
