# Tools

MCP tool logic, one module per tool under `src/tools/`. The wire definitions live in
`src/mcp/tools/`, one `<tool_name>.tool.ts` file per tool.

## Status

| Tool | State | Tests |
|---|---|---|
| `decide` | **implemented and tested** | `test/decide-tool.test.ts` |
| `submit_answers` | **implemented and tested** | `test/submit-answers-tool.test.ts` |
| `feedback` | **implemented and tested** | `test/feedback-tool.test.ts` |
| `get_pending_reviews` | **implemented and tested** | `test/reviews-tool.test.ts` |
| `get_stats` | **implemented and tested** | `test/stats-tool.test.ts` |
| `page_check` | **implemented and tested** | `test/page-check-tool.test.ts` |
| `action_guard` | **planned** | none; nothing is served |

## `page_check`

Takes a `url` and a `snapshot`, and answers everything it can about one page in one call:
`page_type`, `popup` (with the close control when a rule names one), `login_wall`,
`captcha` and `risky_actions[]`.

The `snapshot` is either an object in the browser pack shape
(`{ url, elements: [{ role, text }] }`, optionally with `text`) or the accessibility tree as
text, one element per line, written as `- role "accessible name"`. A line whose first word
is not lower case is treated as page text rather than as an element.

Every part of the answer carries its own `question_id`, `value`, `status`, `confidence`,
`path`, `pattern_id`, `latency_ms`, `decision_id` and `reason`, and every one of them is
written to the decision log by `core/log.ts` with the path, confidence and rule id that
actually produced it. Snapshot text goes through redaction before it is stored, and the
element text in `risky_actions` is redacted on the way out as well.

A part no rule answered carries `value: null` and `status: "needs_ai"`, and appears in
`needs_ai` in the same shape `decide` uses, so `submit_answers` completes it with the same
`decision_id`. **No rule in the shipped browser pack targets `browser.check.page_type`**, so
the page type always comes back that way in this build; the option ids are this server's
contract for a pack that does answer it.

### How a risky action is found

Every element is read separately against `browser.check.risky_action`, because a rule
matches one element at a time. An element a rule flags with `ask_user` or `block` is
reported with its `element_text`, its `risk` (`payment`, `destructive` or `outbound`, read
from the rule id) and the `rule_id` that flagged it. `risk` is `null` when the rule that
fired is not in one of the three shipped families: this server does not guess a kind. An
element no rule flags produces no decision row, because no question was asked about it.

These rows are written with `is_safety` and `needs_review` set when the rule is an advisory
safety rule, so a flagged action appears in `get_pending_reviews` like any other decision
waiting on a person. That is a request for the user and nothing else: the safety check is
**advisory**, nothing in this server stops an agent from acting, and a row flagged
`is_safety` is a record of a request, not of a block.

### What the work is bounded by

`PAGE_CHECK_BOUNDS` bounds one call: 400 elements, 256 characters of one element's text
(the same length the pattern engine already bounds its regular expressions to, so no
`text_regex` rule loses a match), 8192 characters of page text, and 50 reported risky
actions. The bounds are reported on **every** call in `snapshot.bounds`, and anything
actually cut is counted in `snapshot` with `truncated: true`. Nothing is ever cut
silently: a button past the element bound is not reported, and the output says how many
elements were dropped.

### A pack that fails to load

The browser pack is loaded through the pack loader: at start-up in `mcp/start.ts`, and
again by the tool itself when it is called without an engine. A pack that fails to load
never stops the server. The rules that did load are served, `packs.errors` names the file,
the rule and the line of each pack that did not load, and `packs.rule_count` and
`packs.pack_ids` say exactly which rules could answer.

### What this tool does not do

- It does not read the browser. The agent passes the snapshot.
- It does not answer one action; `action_guard` is **planned** and is not served.
- It does not judge whether the rules are right about real pages. Accuracy on real pages is
  **unverified**: the browser pack is measured only on synthetic fixtures.

## `get_stats`

Takes a range (`today`, `7d`, `30d`; default `7d`) and a filter (`all`, `browser`;
default `all`), and reports for that window:

- `total_decisions`, and `counts_by_path` and `fast_path_counts` broken down by path.
- `fast_path_share`: the share of rows in range whose path is `memory`, `pattern` or
  `check`, over every row in range. A slow-path or human answer is never counted as
  fast, however quickly it arrived. `null`, not `0`, when nothing was recorded, because
  zero would claim a measurement that was not made.
- `median_latency_ms` and `p95_latency_ms` from the recorded `latency_ms` of **every**
  decision in range, not only the fast-path ones. The median is the middle value for an
  odd count and the mean of the two middle values for an even one; p95 is nearest rank,
  so it is always a latency that was actually recorded and never an interpolation.
- `time_saved_estimate`, described below.

`today` starts at local midnight. `7d` and `30d` are rolling windows ending at the
clock reading the call used; decisions dated after that reading are left out.

### The `browser` filter

`browser` counts decisions that recorded a page URL or a domain. It is **not** a
per-pack or per-decision-kind filter: the `decisions` table has no column naming the
pack a row belongs to, so this server cannot tell a browser decision from a coding one
and does not pretend to. A decision recorded without a page is counted under `all` and
not under `browser`. When a pack column exists, this filter is what has to change.

### The time-saved estimate is an estimate

`time_saved_estimate.seconds` is the number of fast-path answers in range multiplied by
`ASSUMED_MODEL_CALL_SECONDS_PER_FAST_ANSWER`, a constant in `stats.ts` currently set to
`3` seconds.

**That constant is an assumption, not a measurement.** This server does not call a model,
so it cannot time one. It exists because "how much time did this save" is the question
people ask, and answering nothing would hide it; publishing it without the assumption
would present a guess as a measurement. Every call therefore carries, alongside the
number: `is_estimate: true`, the constant that was assumed, the number of fast answers
it was applied to, and a note saying it was not measured. The tool's text summary says
it too. Replace the constant with a measured figure, or drop the estimate, rather than
tuning it to make a result look better.

Nothing else in the output is estimated: the counts, the path mix, the share and the
latency percentiles all come from rows the decision log wrote.

## `get_pending_reviews`

Takes an optional decision `type`, an optional `older_than_minutes`, and an optional
`limit` (default 20, maximum 200). Items come back oldest first, because this is a
queue, and `matching_count` says how many rows matched before the limit, so a full queue
cannot be mistaken for a short one.

An item is waiting on a person when any of these holds, and the output lists **every**
reason that applies rather than only the first:

- `pending_needs_ai`: path `ai` and the answer `pending` that the router writes when the
  slow path could not answer. A row whose answer has since been submitted does not match.
- `needs_human`: path `human`. No code in this build writes that path yet; the rule is
  here so an item appears as soon as the code that routes to a person writes it.
- `needs_review`: the row is flagged for review whatever its path, so a disputed or
  low-confidence answer is not hidden behind the path it came from.

Redaction runs again on the way out. `core/log.ts` redacts before storing, so most rows
arrive masked already, but that is a property of the writer. Re-running the rules here is
what makes the guarantee this tool states true of its own output: every text field it
returns has been through redaction.

The safety check is **advisory**. An item here, including one flagged `is_safety`, is a
request for a person to look at it. Nothing in this server stops an agent from acting,
and this tool does not claim otherwise: `safety_check` is the literal `advisory` and the
tool description says so.

## Arguments this server refuses

Both tools reject an argument they cannot honour rather than answering about something
else: an unknown range or filter, an unknown decision type, a negative age and a limit
outside 1 to 200. A caller that asked for a 90 day window and received 30 days would be
reading a report about a window it never chose.
