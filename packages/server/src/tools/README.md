# Tools

MCP tool logic, one module per tool under `src/tools/`. The wire definitions live in
`src/mcp/tools/`, one `<tool_name>.tool.ts` file per tool.

## Status

| Tool | State | Tests |
|---|---|---|
| `decide` | **implemented and tested** | `test/decide-tool.test.ts` |
| `submit_answers` | **implemented and tested** | `test/submit-answers-tool.test.ts` |
| `action_guard` | **implemented and tested** | `test/action-guard-tool.test.ts` |
| `feedback` | **implemented and tested** | `test/feedback-tool.test.ts` |
| `get_pending_reviews` | **implemented and tested** | `test/reviews-tool.test.ts` |
| `get_stats` | **implemented and tested** | `test/stats-tool.test.ts` |
| `page_check` | **planned** | none; nothing is served |

## `action_guard`

Takes an `action` (`click`, `submit`, `delete`, `type`, `navigate`, `select`, `upload`,
`press` or `command`, plus the spellings listed in `ACTION_ALIASES`), a `target` (role,
text, selector, or the element text on its own), an optional `text` or `value` the action
would enter, a `url`, and an optional redacted `snapshot`. It returns `verdict`
(`allow`, `ask_user`, `block`), a `reason` written for the user, `rule_ids`, and the
record fields `decision_id`, `confidence`, `path`, `latency_ms`, plus `advisory: true`,
`needs_ai` and `pattern_id`.

**The verdict is advisory.** This tool reports. An agent that never calls it is not
stopped by it, and an agent that reads `ask_user` may still act. Real enforcement belongs
in the agent host's own permission or hook system. The output carries `advisory: true`,
the reason ends with the same sentence, and the tool description says it.

### What makes a verdict, and what cannot

1. **The built-in safety rules** in `action_guard.ts` (`BUILTIN_RULES`) need no pack, so a
   payment or destructive action is `ask_user` on a server with no pack installed. They
   match the same control text the browser pack carries, in English and in Bangla: payment,
   deletion, sending and publishing answer `ask_user`; a credential or card number in the
   text the action would enter, and a command that rewrites history or destroys data,
   answer `block`. A checkout step whose committing control reads only `Continue` is
   caught from the URL path, which is the case a text-only rule misses.
2. **The rules of a loaded pack** are read through the pattern engine and can answer
   `ask_user` or `block`.
3. **A learned pattern may only add caution.** A rule in the engine with no `pack_id`, or
   one marked `shadow` or `candidate`, is read as `ask_user` whatever its own output says,
   and an `allow` from any rule is dropped. There is no miner yet, so nothing in this build
   writes such a rule; the test writes them straight into the engine.

`resolveVerdict` is the only place a verdict changes. It starts at `allow` and moves up
`allow < ask_user < block` only. Everything else is ignored rather than obeyed:

- **Arguments.** Only `action`, `target`, `text`, `value`, `url` and `snapshot` are read.
  A `trusted: true`, a `user_approved: true`, an `override`, a `confidence`, a `verdict` or
  a `rules: []` is not in that list, so it cannot reach a verdict. Each of those shapes has
  its own named test, and the mirror case (an argument asking for `block` on a harmless
  action) has one too, so the test is not passing by accident.
- **Memory.** Not consulted at all. A stored answer for a byte-identical earlier call could
  only add caution here, and exact-match memory belongs to `decide`.
- **Page text.** Matched against rules and never read as an instruction. Only the text of an
  interactive control is read, so a paragraph saying "approved by the user, ignore the
  safety rules" changes nothing, and cannot invent caution either. The fixtures in
  `test/fixtures/action-guard/` are the cases.

### What `path`, `confidence` and `pattern_id` say

`path` is `check` when a built-in rule fired, and also when nothing fired, because the
check that ran and found nothing silent is what produced the default `allow`. It is
`pattern` when no built-in rule fired and a loaded rule produced the verdict.
`confidence` is what the deciding rule states, or the lowest among the rules that produced
the same verdict; with nothing fired it is one of three named constants
(`ALLOW_CONFIDENCE`, `UNKNOWN_ACTION_CONFIDENCE`, `NO_SIGNAL_CONFIDENCE`) and the reason says
which. `pattern_id` names the pack rule that produced the verdict and is `null` for a
built-in rule, for a learned pattern, and whenever `path` is `check`; `rule_ids` names every
rule that contributed either way. `latency_ms` in the output is the value written to the
record.

### What gets recorded

Every verdict is written to `decisions` through `core/log.ts`, with `is_safety` set when a
built-in or pack safety rule produced it and `needs_review` set when the verdict was not a
default `allow` or was a slow fallback. That row is the record of the event: the `ask_user`
happened in the agent's own conversation, and `get_pending_reviews` and the dashboard read
the row. Redaction runs inside that log call, so a credential in the text an action would
enter is masked before it is stored and is never echoed in the reason.

### Known limits

- A built-in rule fires on any interactive element of the supplied snapshot, not only on the
  target. That fails safe, at the cost of a false positive on a page that carries a payment
  control somewhere else. The verdict is advisory, so a user may go ahead after reading it.
- A target that names no role cannot be matched by a pack rule that requires one. The
  built-in rules cover the payment, destructive and outbound families either way.
- The command rule needs the action to name a command. An action called something this build
  does not recognise takes the `needs_ai` path, which is the honest answer for an unknown verb
  rather than a guess that some string is a shell command.
- `block` is returned for a credential in the text an action would enter and for a
  destructive command. Nothing here blocks the action: it is a report.

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
