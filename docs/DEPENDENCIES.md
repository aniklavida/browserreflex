# Dependency Licence Audit

Status: **implemented and tested**. All direct dependencies are recorded with their verified licence and audit date.

## Policy

- Shipped (production) dependencies must be licensed under **MIT**, **Apache-2.0**, **BSD-2-Clause**, **BSD-3-Clause**, or **ISC**.
- Copyleft, SSPL, BSL, or revenue/headcount-gated licences are strictly forbidden for shipped dependencies.
- Every direct dependency (including dev tools) must be recorded here with its licence and verification date.
- Compliance is verified automatically by `scripts/check-licenses.mjs` and enforced in CI.
- A dependency that ships a prebuilt binary is recorded with every optional platform package it resolves, because `pnpm check-licenses` only sees the one that matches the machine it runs on.

## Production dependencies

These ship with `@browserreflex/server` and are installed for anyone who runs the MCP server. `pnpm check-licenses` walks the resolved production tree and reports the licence of each package; it was run on 2026-10-04 and passed.

Redaction (`packages/server/src/security/redact.ts`, 2026-10-04) uses only the Node standard library (`node:crypto`), so it added no dependency to this table.
Pattern engine core (`packages/server/src/patterns/*`, 2026-10-04) uses only the Node standard library and internal helpers, adding no dependency to this table.
Pattern pack loader (`packages/server/src/patterns/loader.ts`, 2026-10-04) uses `yaml` (ISC) for position-accurate YAML parsing and `ajv` (MIT) for JSON schema validation.

The `feedback` tool (`packages/server/src/tools/feedback.ts`, 2026-10-04) reuses the store repositories, the memory module and `redact`, and adds no dependency to this table.

The `action_guard` tool (`packages/server/src/tools/action_guard.ts`, 2026-10-04) uses the pattern engine's own matcher and regex compiler, `security/redact.ts` to recognise a credential, `zod` (MIT, already in the production table above) for the tool's two schemas, `core/log.ts` to record the verdict and the Node standard library for the clock. It reads the `Rule` type the pack loader already produces and adds no dependency to this table. Its fixtures (`packages/server/test/fixtures/action-guard/*.yaml`) are parsed with `yaml` (ISC, already in the table above) and are data rather than code, and the test itself runs on `vitest` (MIT, already in the development table below).

The browser pattern pack (`packages/packs/browser/*.yaml`, 2026-10-04) is versioned YAML read by the loader above, so it adds no dependency: the rules and their 65 synthetic fixtures are data, not code. The fixture test (`packages/server/test/browser-pack.test.ts`) parses those fixtures with `yaml` (ISC, already in the production table above) and runs on `vitest` (MIT, already in the development table below), so it adds nothing to either table.

Signal extraction on capture (`packages/server/src/learning/capture.ts`, 2026-10-04) uses the Node standard library, the internal pattern matchers and `redact`, and adds no dependency to this table.

Confidence calibration (`packages/server/src/learning/calibrate.ts`, 2026-10-04) reads the store's own `feedback` and `decisions` tables and bins the numbers in memory. It uses the Node standard library and internal types only, so it adds no dependency to this table.

The browser miner (`packages/server/src/learning/miners/browser.ts`, 2026-10-04) reads and writes through the store repositories and hashes a group key with the Node standard library (`node:crypto`), and adds no dependency to this table.

The BYOK provider adapters (`packages/server/src/adapters/`, 2026-10-04) call the Anthropic Messages API with the `fetch` built into Node 22 and the Node standard library only, so no provider SDK ships and this table is unchanged. The official Anthropic SDK was considered and not used: this server makes one POST per decision and reads one field of the response, and a package for that would add a dependency tree, its own release cycle and its own licences without removing a line of code. The structured answer is asked for with a forced tool call, which is a documented request field rather than anything the SDK would add.
The BYOK provider adapters (`packages/server/src/adapters/`, 2026-10-04) call the Anthropic Messages API with the `fetch` built into Node 22 and the Node standard library only, so no provider SDK ships and this table is unchanged. The official Anthropic SDK was considered and not used: this server makes one POST per decision and reads one field of the response, and a package for that would add a dependency tree, its own release cycle and its own licences without removing a line of code. The structured answer is asked for with a forced tool call, which is a documented request field rather than anything the SDK would add.

The local REST API and the built UI it serves (`packages/server/src/api/`, 2026-10-04) use only the Node standard library (`node:http`, `node:fs`, `node:path`), so it added no dependency to this table either. There is no web framework: the HTTP server, the router and the static file serving are written against `node:http`.

| Package | Version | Licence | Type | Date Checked |
|---|---|---|---|---|
| `@fontsource/archivo` | `^5.3.0` | OFL-1.1 | production (bundled font assets, not code) | 2026-10-04 |
| `@fontsource/dm-mono` | `^5.3.0` | OFL-1.1 | production (bundled font assets, not code) | 2026-10-04 |
| `@modelcontextprotocol/sdk` | `^1.32.0` | MIT | production | 2026-10-04 |
| `@napi-rs/keyring` | `^2.1.0` | MIT | production | 2026-10-04 |
| `ajv` | `^8.20.0` | MIT | production | 2026-10-04 |
| `better-sqlite3` | `^13.0.3` | MIT | production | 2026-10-04 |
| `react` | `^19.3.0` | MIT | production | 2026-10-04 |
| `react-dom` | `^19.3.0` | MIT | production | 2026-10-04 |
| `react-router-dom` | `^7.18.4` | MIT | production | 2026-10-04 |
| `yaml` | `^2.9.1` | ISC | production | 2026-10-04 |
| `zod` | `^3.25.76` | MIT | production | 2026-10-04 |

The local web UI (`packages/ui`, 2026-10-04) bundles `@fontsource/archivo` and `@fontsource/dm-mono` under SIL Open Font License 1.1 (OFL-1.1). These are static typography assets, not code, bundled into the distribution so that zero remote font requests occur at runtime. `scripts/check-licenses.mjs` explicitly allowlists these two packages with OFL-1.1.

The CLI package (`packages/cli`, published name `browserreflex-mcp`, 2026-10-04) declares one production dependency: `@browserreflex/server`, which is a workspace package and not an npm download, so there is no licence to record for it. Its argument parsing, its JSON and TOML merging, its file writing with backups and its browser launcher (`packages/cli/src/args.ts`, `config-json.ts`, `config-toml.ts`, `config-write.ts`, `open-url.ts`) are written against the Node standard library (`node:fs`, `node:path`, `node:child_process`, `node:url`) and add no entry to the table above. `pnpm check-licenses` was re-run on 2026-10-04 after that package was added and passed.

## Key storage

`packages/server/src/security/keys.ts` (2026-10-04) uses `@napi-rs/keyring` for the operating system keychain backend and only the Node standard library (`node:crypto`, `node:fs`) for the AES-256-GCM encrypted file backend.

`@napi-rs/keyring` is MIT, and every platform package it depends on is MIT. It declares no runtime dependencies at all; the native bindings are twelve optional packages named for the platform and architecture, all MIT:

| Package | Licence | Type |
|---|---|---|
| `@napi-rs/keyring-darwin-arm64` | MIT | production, optional, resolved on macOS on arm64 |
| `@napi-rs/keyring-darwin-x64` | MIT | production, optional, resolved on macOS on x64 |
| `@napi-rs/keyring-win32-x64-msvc` | MIT | production, optional, resolved on Windows |
| `@napi-rs/keyring-linux-x64-gnu` | MIT | production, optional, resolved on Linux (glibc) |
| `@napi-rs/keyring-linux-x64-musl` | MIT | production, optional, resolved on Linux (musl) |

The remaining optional platform packages follow the same pattern and the same licence: `darwin` and `win32` on `ia32` and `arm64`, `linux` on `arm64`, `riscv64` and `arm-gnueabihf` in both `gnu` and `musl` flavours, and `freebsd-x64`.

`pnpm check-licenses` prints `@napi-rs/keyring` and none of the twelve platform packages: the command reports the packages a workspace project depends on, not the optional ones the current machine happened to resolve. The platform packages are therefore recorded by hand above, and the checker cannot be the evidence for them. On macOS on arm64 the resolved platform package was confirmed present and MIT on 2026-10-04.

Each platform package ships a prebuilt binary, so no compiler is needed to install. Because the platform packages are optional, a platform with no prebuilt binary still installs: the keychain backend then fails to load and `resolveKeyStore` falls back to the encrypted file store and reports `fellBack: true`.

`keytar` was considered and rejected: it is archived, so it receives no fixes for a platform this project supports.

## Other production dependencies

`@modelcontextprotocol/sdk` declares `zod` and `@cfworker/json-schema` as peer dependencies. Both are MIT and both are resolved into the production tree, so both are covered by the check above. The checker prints `0.0.0` as the version of every package because `pnpm licenses list --json` does not include a version field per package, so the check verifies licences, not versions.

## Development dependencies (dev-only)

Development tools are not shipped to end-users or bundled in production packages.

| Package | Version | Licence | Type | Date Checked |
|---|---|---|---|---|
| `@eslint/js` | `^9.20.0` | MIT | dev-only | 2026-10-04 |
| `@testing-library/react` | `^16.3.3` | MIT | dev-only | 2026-10-04 |
| `@types/better-sqlite3` | `^9.6.0` | MIT | dev-only | 2026-10-04 |
| `@types/node` | `^22.13.4` | MIT | dev-only | 2026-10-04 |
| `@types/react` | `^19.3.0` | MIT | dev-only | 2026-10-04 |
| `@types/react-dom` | `^19.3.0` | MIT | dev-only | 2026-10-04 |
| `@vitejs/plugin-react` | `^6.1.1` | MIT | dev-only | 2026-10-04 |
| `eslint` | `^9.20.0` | MIT | dev-only | 2026-10-04 |
| `jsdom` | `^30.1.1` | MIT | dev-only | 2026-10-04 |
| `prettier` | `^3.5.1` | MIT | dev-only | 2026-10-04 |
| `tsx` | `^4.23.15` | MIT | dev-only (runs the server from TypeScript in the stdio tests) | 2026-10-04 |
| `typescript` | `~5.8.3` | Apache-2.0 | dev-only | 2026-10-04 |
| `typescript-eslint` | `^8.24.0` | MIT | dev-only | 2026-10-04 |
| `vite` | `^8.3.2` | MIT | dev-only | 2026-10-04 |
| `vitest` | `^3.0.5` | MIT | dev-only | 2026-10-04 |

The MCP inspector was used by hand to check the server (`npx
@modelcontextprotocol/inspector`, MIT). It is not a dependency of the repository and is
not installed by it.
