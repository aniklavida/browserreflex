# Learning

Learning loop: capture, mine, shadow test, promote, monitor, and demote candidate
patterns.

## Status

| Step | State | Tests |
|---|---|---|
| Capture | **implemented and tested** | `test/capture.test.ts` |
| Mine, browser | **implemented and tested** | `test/miner-browser.test.ts` |
| Mine, text keyword | **implemented and tested** | `test/miner-text.test.ts` |
| Confidence calibration | **implemented and tested** | `test/calibrate.test.ts` |
| Shadow test | **implemented and tested** | `test/shadow.test.ts` |
| Promote | **implemented and tested** | `test/promote.test.ts` |
| Re-check, demote, drift alert | **implemented and tested** | `test/monitor.test.ts` |

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
  flag off. Nothing loads a shadow pattern into the fast path; a candidate only becomes
  active through the promotion rules below. Monitoring and demotion are **planned**.
- The rule it writes is the engine's typed `Rule`, in `patterns.rules`, so shadow
  testing can load it with `compileRule`. It also passes the shipped pack schema.
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

## Shadow test

`shadow.ts` evaluates candidate patterns (`status: 'shadow'`) against slow-path answers
(`submit_answers`) and human corrections (`feedback`). Candidate rules run silently
while the model or human still provides the answer, allowing agreement and accuracy
to be measured without altering served decisions.

What it holds to, in one line each:

- Candidate rules are matched against stored decision signals and page snapshots using
  the engine's compiled matchers.
- A candidate's output value is compared with the recorded answer; one `shadow_samples`
  row is written and `pattern_stats` (`sample_count`, `agreed_count`, `disagreed_count`,
  `last_evaluated_at`, `updated_at`) is updated in one atomic transaction.
- The same (decision, pattern) pair evaluated twice is a no-op: existing records are
  preserved and sample counts are not inflated.
- Shadow rules never alter decide results and the pattern engine never serves shadow
  candidates.
- A shadow candidate never carries the safety flag and cannot touch safety rules. The
  safety check is advisory, and nothing here prevents an agent from acting.
- Tool integration: hooked into `submit_answers` and `feedback` end to end; any failure
  inside shadow evaluation is logged and does not fail the tool call.
- Promotion is described below; re-check, demotion and drift alerts are in the Monitor section.

## Promote

`promote.ts` turns a shadow candidate into an active pattern. It runs after each recorded
shadow sample and can be called over every candidate. What it holds to, in one line each:

- A candidate needs 20 samples and 95% agreement. One that touches payment, destructive or
  outbound actions, or whose samples come from decisions flagged as safety, needs 50
  samples and 99%.
- The thresholds are in settings. A safety threshold cannot be set below 50 samples or 99%,
  and never below the standard one.
- A promoted pattern never carries the safety flag and loses to a safety rule that matches
  the same input. The safety check is advisory: it reports and does not stop an agent.
- Its answer confidence is capped by its measured agreement.
- Promotion is one transaction, is idempotent, and writes a promotion event with the
  samples, agreement and thresholds used. A failure in promotion is logged and never fails
  `submit_answers` or `feedback`.
- **A known limit:** promoted patterns are loaded into the fast path when the MCP server
  starts, so a pattern promoted during a session is served after the next start.

## Monitor: re-check, demote, drift alert

`monitor.ts` watches the learned patterns that promotion made active. A learned pattern is
one with a promotion event: the decision log writes a stub pattern row for every rule that
answers, pack rules and safety rules included, so a row alone is not enough, and a rule
with no promotion event is never re-checked, demoted or disabled. What it holds to, in one
line each:

- **Re-check.** `decide` samples 2% of the answers that came from an active learned pattern
  (`monitor.recheck_rate`; the random source is injectable so tests are deterministic). The
  answer is returned unchanged. A sampled decision gets a pending re-check row and is flagged
  `needs_review`, so `get_pending_reviews` lists it.
- **Completing a re-check.** The sampled decision already holds the pattern's answer, so
  `submit_answers` does not apply. `feedback` completes it: the correct value is compared
  with the pattern's answer and recorded as agree or disagree in the re-check row. The
  re-check outcome is not added to `pattern_stats` a second time.
- **Demote.** When the last 20 completed re-checks (`monitor.recheck_window`) agree less
  than 90% of the time (`monitor.demotion_threshold`, never set below 90%), the pattern is
  set to `disabled`, removed from the live engine without a restart, and a demotion event
  and a drift alert are written, in one transaction. It is idempotent. Fewer than 20 completed
  re-checks never demotes.
- **Drift alert.** Active alerts are reported by `get_stats` in `drift_alerts` (a count and
  the newest ten). The alert says which pattern was disabled and why.
- A pack rule or a safety rule is never demoted by this module. The safety check is advisory:
  it reports a request to the user and does not stop an agent from acting.
- A failure in re-check or demotion is logged and never fails `decide` or `feedback`.
- **A known limit:** the re-check outcome only arrives if the agent or the user answers the
  pending review with `feedback`. A re-check nobody answers stays pending and counts for
  nothing. Promoted patterns load into the live engine at server start, so one promoted
  during a session is served after the next start.
