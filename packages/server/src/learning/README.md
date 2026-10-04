# Learning

Learning loop: capture, mine, shadow test, promote, monitor, and demote candidate
patterns.

## Status

| Step | State | Tests |
|---|---|---|
| Capture | **implemented and tested** | `test/capture.test.ts` |
| Confidence calibration | **implemented and tested** | `test/calibrate.test.ts` |
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

## Confidence calibration

`calibrate.ts` makes the claim "says 90%" answerable against "right 90%". Per group (a
pattern id, or a URL path when no rule named the answer, plus the decision type) it bins
the stated confidence into ten bins, reads the share of feedback-confirmed answers in the
bin that were right, and maps a stated confidence to that share, blended with the bin's own
mean stated confidence in proportion to its sample count. `MIN_SAMPLES` (20) is where a bin
stops needing the blend. `calibrationError` reports the expected calibration error, so the
error can be measured before and after on the same history.

The router calls it for pattern answers only, through the pure `calibrate` with the history
`readCalibrationHistory` reads from the store:

- A bin with no confirmed sample returns the stated confidence unchanged, and so does any
  answer whose rule has no corrections yet. Absence of feedback is not confirmation.
- Only the confidence moves. The value, the path and the pattern id are the rule's own, and
  the decision row stores the confidence the answer carried.
- A safety rule keeps its stated confidence. Its verdict does not depend on its confidence,
  so there is nothing to adjust, and the safety check is advisory either way.
- A sample needs a correction. A rule whose answers are all accepted silently is never
  calibrated, and a rule that is corrected only when it is wrong is calibrated low. The
  module header lists that limit and the rest in full.