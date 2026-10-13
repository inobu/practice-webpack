# Dependency audit policy

Run `npm run audit:ci` to audit the complete dependency tree. High findings
without a matching exception and all Critical findings fail CI. Audit command
errors, malformed reports, and incomplete dependency graphs also fail the check.
Moderate findings are reported, as with the previous `--audit-level=high` gate.

The check writes the unfiltered npm response to `audit-report.json`. GitHub
Actions uploads it as `npm-audit-report`, including when the audit fails.
A passing policy check does not mean that the raw npm audit has no findings.

## Temporary development exception

`GHSA-vfj7-8cjw-p6xm` affects braces 3.0.3 and propagates through the development
server dependencies. No patched upstream release is available as of 2026-10-13.
The current server binds to 127.0.0.1, watches a fixed dist directory, and has no
proxy or untrusted glob configuration.

The exception in `scripts/audit-policy.json` is valid through 2026-10-20 JST.
It stops matching at 2026-10-21 00:00:00 JST. It is limited to the reviewed
development nodes and exact versions; production dependencies never qualify.
Changes to the webpack configuration or start command require a new review.
Critical findings cannot use this exception, even if the advisory ID matches.

Review the upstream fix and dependency paths before the deadline. Remove the
exception after remediation. Any extension must be an explicit policy change;
the check does not renew it automatically.
