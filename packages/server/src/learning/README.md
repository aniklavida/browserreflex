# Learning

Learning loop: capture, mine, shadow test, promote, monitor, and demote candidate
patterns.

## Status

| Step | State | Tests |
|---|---|---|
| Capture | **implemented and tested** | `test/capture.test.ts` |
| Mine, shadow test, promote, monitor, demote | **planned** | none; nothing is served |

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