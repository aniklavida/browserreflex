# Dependency Licence Audit

Status: **implemented and tested**. All direct dependencies are recorded with their verified licence and audit date.

## Policy

- Shipped (production) dependencies must be licensed under **MIT**, **Apache-2.0**, **BSD-2-Clause**, **BSD-3-Clause**, or **ISC**.
- Copyleft, SSPL, BSL, or revenue/headcount-gated licences are strictly forbidden for shipped dependencies.
- Every direct dependency (including dev tools) must be recorded here with its licence and verification date.
- Compliance is verified automatically by `scripts/check-licenses.mjs` and enforced in CI.

## Production dependencies

Shipped production dependencies compiled or bundled into runtime packages.

| Package | Version | Licence | Type | Date Checked |
|---|---|---|---|---|
| `better-sqlite3` | `^13.0.3` | MIT | production | 2026-10-04 |

## Development dependencies (dev-only)

Development tools are not shipped to end-users or bundled in production packages.

| Package | Version | Licence | Type | Date Checked |
|---|---|---|---|---|
| `@eslint/js` | `^9.20.0` | MIT | dev-only | 2026-10-04 |
| `@types/better-sqlite3` | `^9.6.0` | MIT | dev-only | 2026-10-04 |
| `@types/node` | `^22.13.4` | MIT | dev-only | 2026-10-04 |
| `eslint` | `^9.20.0` | MIT | dev-only | 2026-10-04 |
| `prettier` | `^3.5.1` | MIT | dev-only | 2026-10-04 |
| `typescript` | `~5.8.3` | Apache-2.0 | dev-only | 2026-10-04 |
| `typescript-eslint` | `^8.24.0` | MIT | dev-only | 2026-10-04 |
| `vitest` | `^3.0.5` | MIT | dev-only | 2026-10-04 |
