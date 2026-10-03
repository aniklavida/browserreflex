# Dependency Licence Audit

Status: **implemented and tested**. All direct dependencies are recorded with their verified licence and audit date.

## Policy

- Shipped (production) dependencies must be licensed under **MIT**, **Apache-2.0**, **BSD-2-Clause**, **BSD-3-Clause**, or **ISC**.
- Copyleft, SSPL, BSL, or revenue/headcount-gated licences are strictly forbidden for shipped dependencies.
- Every direct dependency (including dev tools) must be recorded here with its licence and verification date.
- Compliance is verified automatically by `scripts/check-licenses.mjs` and enforced in CI.

## Production dependencies

These ship with `@browserreflex/server` and are installed for anyone who runs the MCP
server. `pnpm check-licenses` walks the resolved production tree and reports the licence
of each package; it was run on 2026-10-04 and passed.

| Package | Version | Licence | Type | Date Checked |
|---|---|---|---|---|
| `@modelcontextprotocol/sdk` | `^1.32.0` | MIT | production | 2026-10-04 |
| `zod` | `^4.6.5` | MIT | production | 2026-10-04 |

`@modelcontextprotocol/sdk` declares `zod` and `@cfworker/json-schema` as peer
dependencies. Both are MIT and both are resolved into the production tree, so both are
covered by the check above.

The SDK's own dependencies were checked on 2026-10-04 as well: 91 resolved production
packages, all MIT, BSD-2-Clause, BSD-3-Clause or ISC. Nothing in that tree is
copyleft, source-available or licence-gated. One caveat about the checker itself: it
prints `0.0.0` as the version of every package because `pnpm licenses list --json` does
not include a version field per package, so the check verifies licences, not versions.

## Development dependencies (dev-only)

Development tools are not shipped to end-users or bundled in production packages.

| Package | Version | Licence | Type | Date Checked |
|---|---|---|---|---|
| `@eslint/js` | `^9.20.0` | MIT | dev-only | 2026-10-04 |
| `@types/node` | `^22.13.4` | MIT | dev-only | 2026-10-04 |
| `eslint` | `^9.20.0` | MIT | dev-only | 2026-10-04 |
| `prettier` | `^3.5.1` | MIT | dev-only | 2026-10-04 |
| `tsx` | `^4.23.15` | MIT | dev-only (runs the server from TypeScript in the stdio tests) | 2026-10-04 |
| `typescript` | `~5.8.3` | Apache-2.0 | dev-only | 2026-10-04 |
| `typescript-eslint` | `^8.24.0` | MIT | dev-only | 2026-10-04 |
| `vitest` | `^3.0.5` | MIT | dev-only | 2026-10-04 |

The MCP inspector was used by hand to check the server (`npx
@modelcontextprotocol/inspector`, MIT). It is not a dependency of the repository and is
not installed by it.
