# API

Local HTTP endpoints and the built UI, served from the process that runs the MCP
server.

## Status

- Local REST API (`server.ts`, `router.ts`, `handlers.ts`): **implemented and
  tested**.
- Localhost guard (`guard.ts`): **implemented and tested**.
- Settings masking and refusal (`settings-mask.ts`): **implemented and tested**.
- Serving a built UI (`static-ui.ts`): **implemented and tested** against a
  directory a test builds. `packages/ui` builds into `dist/`, which the CLI serves.
- Wiring the API into the MCP start-up or the CLI: **planned**.

## Endpoints

All responses are JSON, snake_case, served on `127.0.0.1`.

| Method | Path | Answers |
|---|---|---|
| GET | `/api/stats` | Counts over the local store, including the fast-path share and the number of active drift alerts |
| GET | `/api/decisions` | A page of decisions; filters `session_id`, `domain`, `path`, `needs_review`, `is_safety`, `limit`, `offset` |
| GET | `/api/decisions/:id` | One decision |
| GET | `/api/reviews` | The decisions waiting for a person; `limit`, `offset` |
| POST | `/api/reviews/:id/answer` | Stores `{ correct_value, note }` through the `feedback` function, clears the review flag, reports what the answer changed |
| POST | `/api/reviews/bulk` | Stores `{ answers: [{ decision_id, correct_value, note }] }` the same way, reporting per-item errors |
| GET | `/api/settings` | Every setting, with credential values masked |
| PUT | `/api/settings` | Stores `{ key, value }`; refuses a credential name or a value carrying a secret |
| GET | `/api/packs` | Pattern packs; filter `active`, `limit`, `offset` |
| GET | `/api/patterns` | Learned and written patterns; filters `pack_id`, `domain`, `status`, `decision_type`, `is_safety`, `limit`, `offset` |
| GET | `/api/decisions?q=&from=&to=&pattern_id=` | The same page of decisions, also filtered by a literal text search over the question and the answer, a time range (`to` is exclusive) and a pattern |
| GET | `/api/stream` | A server-sent event stream: one `decision` event for each decision recorded after the stream opened (polled once a second) |
| GET | `/api/sessions` | One row per session with its agent, decision count, fast, model and person counts, first and last time |
| PUT | `/api/packs/:id` | `{ active: boolean }`. A pack that is off stops answering with its non-safety rules; its safety rules keep working |
| PUT | `/api/patterns/:id` | `{ status: "active" \| "disabled" }`. A safety pattern is refused (403); a written pack rule is refused (409: switch its pack off instead); only a pattern promotion made active can be switched on, and not while a drift alert for it is open (409) |
| GET | `/api/pattern-stats` | Sample, agree and disagree counts per pattern |
| GET / PUT / DELETE | `/api/keys`, `/api/keys/:provider` | Whether a provider key is stored and its masked form; store or remove one. The key itself is never returned |
| POST | `/api/keys/test` | One small call to the provider with the stored key. Experimental: never run against a live provider by the test suite |
| GET | `/api/data` | The database file name and size, decision count, oldest decision, retention setting and recent backups |
| POST | `/api/backup` | Writes a consistent backup into a `backups` folder beside the database |
| POST | `/api/retention/purge` | `{ days, confirm: true }` deletes decisions older than `days` days. Not undoable |
| GET | `/api/integrations` | Which supported agents have a BrowserReflex entry in their configuration file |
| GET | `/api/analytics/quality`, `/safety`, `/agents` | Stated confidence against what turned out right; safety records by family; decisions by agent and project |
| GET / PUT | `/api/drift`, `/api/drift/:id` | Re-check accuracy per pattern and the drift alerts; acknowledge or resolve an alert |
| GET | `/api/export/decisions.csv` | A CSV of decisions; a cell that starts like a formula is prefixed so a spreadsheet will not run it |

Anything else under `/api/` answers 404. Anything outside `/api/` is served from
the configured UI directory when there is one.

## Invariants

- **Local only.** The server binds to `127.0.0.1` and there is no option to
  change that. A request is answered only when the remote address is loopback and
  the Host header names a loopback host, so a name that resolves to 127.0.0.1 is
  refused. A browser request carrying an Origin must name an allowed local origin.
  A refused request runs no handler.
- **A provider key is stored by `PUT /api/keys` and nowhere else.** It goes to the operating
  system keychain (or the encrypted file), and no route, log line or error returns it.
- **A credential never reaches the settings table.** A setting whose
  name signals a credential reads as `[redacted]`, a value the redaction rules
  would mask is masked whatever its name, and a write of either is refused rather
  than stored. Provider keys belong in the operating system keychain, which is
  **planned**.
- **Nothing is repaired silently.** An invalid body is a 4xx with the reason, a
  body over 512 KiB is a 413, and a `correct_value` the decision's type cannot
  hold is a 400 that stores nothing and leaves the item in the queue.
- **A record is not rewritten by being answered.** Answering a review item goes
  through `executeFeedback`, the same function the `feedback` tool uses: the value
  is checked against the decision type, the note is redacted before it is stored,
  and the pattern statistics are updated. On top of that the API clears the review
  flag and reports what the answer changed, and nothing more. It does not change
  the path or the confidence the decision was recorded with.
- **The safety check stays advisory.** This API reads and records; it does not
  enforce a safety rule and does not stop an agent from acting.

## Dependencies

None beyond the Node standard library: `node:http`, `node:fs` and `node:path`.
No web framework is used, so there is no new production dependency to record in
`docs/DEPENDENCIES.md`.