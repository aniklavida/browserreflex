# API

Local HTTP endpoints and the built UI, served from the process that runs the MCP
server.

## Status

- Local REST API (`server.ts`, `router.ts`, `handlers.ts`): **implemented and
  tested**.
- Localhost guard (`guard.ts`): **implemented and tested**.
- Settings masking and refusal (`settings-mask.ts`): **implemented and tested**.
- Serving a built UI (`static-ui.ts`): **implemented and tested** against a
  directory a test builds. The UI itself is **planned**: `packages/ui` is an empty
  placeholder package, so there is no build to serve yet.
- Wiring the API into the MCP start-up or the CLI: **planned**.

## Endpoints

All responses are JSON, snake_case, served on `127.0.0.1`.

| Method | Path | Answers |
|---|---|---|
| GET | `/api/stats` | Counts over the local store, including the fast-path share |
| GET | `/api/decisions` | A page of decisions; filters `session_id`, `domain`, `path`, `needs_review`, `is_safety`, `limit`, `offset` |
| GET | `/api/decisions/:id` | One decision |
| GET | `/api/reviews` | The decisions waiting for a person; `limit`, `offset` |
| POST | `/api/reviews/:id/answer` | Stores `{ correct_value, note }` through the `feedback` function, clears the review flag, reports what the answer changed |
| POST | `/api/reviews/bulk` | Stores `{ answers: [{ decision_id, correct_value, note }] }` the same way, reporting per-item errors |
| GET | `/api/settings` | Every setting, with credential values masked |
| PUT | `/api/settings` | Stores `{ key, value }`; refuses a credential name or a value carrying a secret |
| GET | `/api/packs` | Pattern packs; filter `active`, `limit`, `offset` |
| GET | `/api/patterns` | Learned and written patterns; filters `pack_id`, `domain`, `status`, `decision_type`, `is_safety`, `limit`, `offset` |

Anything else under `/api/` answers 404. Anything outside `/api/` is served from
the configured UI directory when there is one.

## Invariants

- **Local only.** The server binds to `127.0.0.1` and there is no option to
  change that. A request is answered only when the remote address is loopback and
  the Host header names a loopback host, so a name that resolves to 127.0.0.1 is
  refused. A browser request carrying an Origin must name an allowed local origin.
  A refused request runs no handler.
- **A credential never reaches the API or the settings table.** A setting whose
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