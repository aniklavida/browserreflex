# Learning

Learning loop: capture, mine, shadow test, promote, monitor, and demote candidate
patterns.

## Status

| Step | State | Tests |
|---|---|---|
| Capture | **implemented and tested** | `test/capture.test.ts` |
| Mine, browser | **implemented and tested** | `test/miner-browser.test.ts` |
| Mine, text keyword | **implemented and tested** | `test/miner-text.test.ts` |
| Shadow test, promote, monitor, demote | **planned** | none; nothing is served |

## Capture

`capture.ts` stores the features a miner needs with every slow decision, in
`decision_signals`: domain, URL path with the query string and fragment removed,
element role, element text, selector, and normalised tokens. The module header
documents the normalisation and the invariants in full. What it holds to, in one
line each:

- Every text field goes through `security/redact.ts` before storage, and tokens
  are built from already-redacted text.
- A fast-path answer (`memory`, `pattern`, `check`) captures nothing. Capture runs
  when the slow path completes, which is `submit_answers` writing path `ai`, and
  when `feedback` records a human correction.
- A row names where its element fields came from (`element_source`), so
  `first_snapshot_element` cannot be read as the element the decision was about.
- A write that fails reports `write_failed`; `stored: true` always means the row
  is there.

`store.signals.list({ domain, path })` is the query the miner uses. Both are
indexed columns; the answer, the confidence and the decision type stay on the
`decisions` row, so a miner joins the two.

Coding signals, a normalised error signature and file paths, are **planned** for
the coding pack. Nothing in `capture.ts` extracts them.

## Mine, browser

`miners/browser.ts` reads the captured signals, joins each to its decision for the
answer, groups the samples by decision type, domain, path, element role, element text
and question, and writes one candidate pattern per group that agreed. The module
header documents the group key, the confidence formula and every skip reason in full.
What it holds to, in one line each:

- A group needs `MIN_AGREEING` (3) agreeing decisions **and** no disagreement
  anywhere in it. Any disagreement creates nothing at all, not even a candidate for
  the majority value.
- A candidate is written with `status: 'shadow'`, `kind: 'learned'` and the safety
  flag off. Nothing loads a shadow pattern into the fast path and nothing calls this
  module: promotion, shadow testing, monitoring and demotion are **planned**.
- The rule it writes is the engine's typed `Rule`, in `patterns.rules`, so the shadow
  card can load it with `compileRule`. It also passes the shipped pack schema.
- The id is derived from the group, so mining the same group twice reports
  `already_mined` instead of writing a second row.
- The report says what it did not do: rows read, rows that joined a group, every skip
  with its reason, and whether a `limit` left rows unread.
- A corrected decision is not mined (`feedback` leaves the decision row holding the
  answer that was corrected), and a row that says the slow path answered a decision
  the decision row calls a fast path is not mined either.
- The safety check is advisory, and a learned candidate never carries the safety
  flag. A decision a safety rule answered is not mined at all.
- **A known limit:** `matchForQuestion` wants a distribution over every option of a
  `choice` question and the store keeps no options, so a mined `choice` candidate is
  not returned by that call. A mined `check` or `score` candidate is. Nothing here
  invents a distribution.