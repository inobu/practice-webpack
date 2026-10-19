# Dependency audit policy

Run `npm run audit:ci` to audit the complete dependency tree. High findings
without a matching exception and all Critical findings fail CI. Audit command
errors, malformed reports, and incomplete dependency graphs also fail the check.
Moderate findings are reported, as with the previous `--audit-level=high` gate.

The check writes the unfiltered npm response to `audit-report.json`. GitHub
Actions uploads it as `npm-audit-report`, including when the audit fails.
A passing policy check does not mean that the raw npm audit has no findings.

## SockJS UUID fix

`webpack-dev-server` stays on the Node.js 20-compatible 5.x line (now 5.2.7).
Its SockJS dependency declares uuid ^8.3.2. A scoped npm override pins
only SockJS's uuid to the CommonJS-compatible 11.1.1, which fixes
[`GHSA-w5hq-g745-h8pq`](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq).
SockJS uses `require('uuid').v4()` without arguments. Its connection IDs and a
real WebSocket message round trip are verified by `npm run test:sockjs`.
Remove the override when SockJS declares a patched dependency itself, or after
a separately reviewed migration removes SockJS.

## Temporary development exception: reviewed 2026-10-19

### Upstream status and locked dependency paths

The [GitHub advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
still lists braces <=3.0.3 as affected and no patched version. A live query of
the [npm registry](https://registry.npmjs.org/braces/latest) on 2026-10-19
returned 3.0.3 as latest; the version history contains no later release.
The [upstream issue](https://github.com/micromatch/braces/issues/70) remains open.
The maintainer disputes the advisory's applicability to trusted patterns; that
comment is not a patch or grounds to suppress arbitrary uses of this package.

Both installed copies are development-only (`dev: true` in the lockfile):

| Dependency path | braces lockfile node |
| --- | --- |
| webpack-dev-server 5.2.7 -> chokidar 3.6.0 -> braces 3.0.3 | `node_modules/chokidar/node_modules/braces` |
| webpack-dev-server 5.2.7 -> http-proxy-middleware 2.0.10 -> micromatch 4.0.8 -> braces 3.0.3 | `node_modules/http-proxy-middleware/node_modules/braces` |

The only dependency update is webpack-dev-server 5.2.6 -> 5.2.7, published on
2026-10-18. Its [release notes](https://github.com/webpack/webpack-dev-server/releases/tag/v5.2.7)
describe Host/Origin and proxied WebSocket validation fixes. Its Node engine
remains >=18.12.0. Its dependency declarations are unchanged, so this update
does **not** fix braces. The scoped SockJS UUID override is retained.

### Reachability review and compensating controls

Source review covered the locked Chokidar `index.js`, webpack-dev-server
`lib/Server.js`, http-proxy-middleware `dist/context-matcher.js`, and project
configuration and source. For the reviewed configuration:

- The server binds to `127.0.0.1`. Host validation, cross-site script rejection,
  and rejection of a foreign WebSocket Origin are exercised by the smoke test.
- The only static watcher is the fixed `dist` directory. Globbing is explicitly
  disabled and symlinks are not followed. Chokidar's `_getWatchHelpers` then
  sets `hasGlob` to false, so `getDirParts` returns before `braces.expand`.
  A 4,500-level brace pattern is checked against the actual watcher without
  filesystem path-length limits. A real file change still reaches the browser
  WebSocket as `static-changed`, verifying that live reload continues to work.
- There is no proxy or extra `watchFiles` configuration. webpack-dev-server
  requires http-proxy-middleware only inside its proxy setup branch. The smoke
  test verifies that module is not loaded at startup or after HTTP requests.
  Request query data containing a deeply nested brace pattern does not become
  a glob; the compiled bundle remains available.
- No application source accepts user-supplied glob patterns. A production-only
  audit reports zero findings; the webpack output contains application and
  loader runtime code, not this development server dependency tree.

These observations support a narrow, temporary exception for this configuration,
not a claim that braces is fixed or that arbitrary local requests are safe.
On Node.js 20.20.2, isolated child processes reproduced a stack overflow in
`compile` and `expand` for **both** installed braces copies using 4,500 nested
braces around `a,b` (9,003 characters, below the default length cap).

Run the reviewed `npm start` command in a trusted checkout. Do not add command
line overrides that expose the server, tunnels, proxy filters, or untrusted
watch/ignore patterns. A malicious local configuration or a future integration
that calls braces with untrusted patterns can still terminate a Node process.
The policy hashes the committed webpack configuration and checks the start
script; it cannot enforce what a developer adds to a local command line.

### Deadline and decision

The existing master exception is scheduled to stop matching at
**2026-10-21 00:00 JST**. After this review and stronger watcher controls,
the proposed policy allows **one
seven-day extension, until 2026-10-28 00:00 JST** (2026-10-27 15:00 UTC).
This is a bounded period to reassess upstream and choose an alternative, not
an expectation that an upstream patch will be released within seven days.
Merging the policy change accepts the residual development-only availability
risk for that period. Without that merge, master keeps its original deadline.

The exception remains limited to the same six development nodes and exact
versions, with only the reviewed webpack-dev-server version changed to 5.2.7.
Its configuration hash is updated for the hardened watcher. Production nodes,
new paths or versions, other High advisories, and all Critical findings fail
the policy. Configuration/start command changes require another review.
Boundary tests cover the original deadline and the renewed deadline, including
the exact UTC instant. The check never renews itself.

| Option | Assessment on 2026-10-19 |
| --- | --- |
| Harden the watcher and extend once to October 28 | Smallest change preserving Node 20 and the development workflow; vulnerable packages and raw High findings remain. Recheck by the end of October 27 JST and remove the exception when remediated. |
| Keep the October 21 deadline | Avoids accepting more time at risk; if the same findings remain, CI intentionally fails at midnight. |
| Remove webpack-dev-server | Removes both current braces paths. Requires replacing or pausing `npm start` and live reload, removing obsolete SockJS override/tests, and revalidating the lockfile, build and serving workflow. This is the fallback if further acceptance is unsuitable. |
| Force transitive major upgrades | Chokidar 4 removes its braces dependency, but it is outside the server's declared range and leaves the proxy path. Node 20-compatible http-proxy-middleware 3.0.7 still declares micromatch ^4.0.8, whose latest release still needs braces. Not a complete minimal fix. |
| Upgrade to webpack-dev-server 6.1.0 | Requires Node >=22.15.0; its proxy dependency still declares micromatch. Fails the current Node 20 constraint and does not establish removal of all braces paths. |
| Maintain a reviewed fork/vendor patch | Could add depth guards, but adds code, licensing and regression maintenance. Needs a separate review of every affected entry point; renaming a vulnerable package version to silence audit is not remediation. |

Reproduce the registry and local checks with Node.js 20 (reviewed with 20.20.2
and npm 10.8.2):

```sh
npm view braces version dist-tags time --json --registry=https://registry.npmjs.org
npm view webpack-dev-server@5.2.7 engines dependencies --json
npm ci --engine-strict
npm ls braces chokidar http-proxy-middleware micromatch webpack-dev-server sockjs uuid
npm run build
npm test
npm run audit:ci
npm audit --omit=dev --json
```

The full audit still reports **0 Critical, 5 High, 5 Moderate**. The five High
entries are this advisory and its parent propagation, not five independently
accepted advisories. The Moderate findings remain reported under the existing
High-or-above gate and are not fixed by this review.
