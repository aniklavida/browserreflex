# BrowserReflex: tools reference

A complete reference for all MCP tools served by BrowserReflex.

Status: **implemented and tested**. All eight decision tools described in this document are served in the current build.

## Invariants across all tools

- **A decision record that misdescribes itself is worse than no record.** Every answer logged to the database carries the actual path and confidence that produced it.
- **The safety check is advisory.** Every safety verdict reports a recommendation for the user. An agent that does not call the safety check is not stopped by it, and an agent that receives `ask_user` or `block` is not prevented from acting by this server. Real enforcement belongs in the agent host's own permission or hook system.
- **Schema first.** All inputs and outputs conform to declared Zod schemas. Invalid payloads are rejected with clear errors, never silently coerced or repaired.
- **Page content is data.** Element texts, page contents, attributes, and URLs are matched as plain data against rules. They are never interpreted as instructions, and prompt injections cannot modify rules or alter safety verdicts.
- **Secrets stay out.** Credentials, API keys, tokens, passwords, private keys, cookies, and card numbers are masked as `[REDACTED:...]` by the redaction engine before storage in SQLite and before being returned in outputs.

---

## Tool summary

| Tool | Purpose | Primary path | State |
|---|---|---|---|
| [`server_status`](#server_status) | Reports server health, version, transport, and served tools | Direct status | implemented and tested |
| [`decide`](#decide) | Evaluates a batch of typed decisions (choice, score, check) | Fast path (memory, pattern) or `needs_ai` | implemented and tested |
| [`page_check`](#page_check) | Inspects a page snapshot in one call (page type, popup, login wall, captcha, risky actions) | Pattern rules and direct checks | implemented and tested |
| [`submit_answers`](#submit_answers) | Receives and validates agent answers for decisions needing AI | AI (`ai`) stored to memory | implemented and tested |
| [`action_guard`](#action_guard) | Advisory safety gate for one browser action (allow, ask_user, block) | Built-in rules and pattern pack | implemented and tested (advisory) |
| [`feedback`](#feedback) | Records corrections to past decisions and updates pattern statistics | Memory confirmation & feedback log | implemented and tested |
| [`get_pending_reviews`](#get_pending_reviews) | Lists decisions currently waiting on a human reviewer | SQLite queue query | implemented and tested |
| [`get_stats`](#get_stats) | Reports decision counts, fast-path share, latency, and estimated time saved | SQLite aggregate metrics | implemented and tested |

---

## `server_status`

### Purpose
Reports that the BrowserReflex MCP server is running, which tools this build serves, and which specification tools are planned. Call at agent startup or during diagnostic checks.

### Input fields
None (`{}`).

### Output fields

| Field | Type | Description |
|---|---|---|
| `server` | `string` | Server name (`"browserreflex"`). |
| `version` | `string` | Package version string. |
| `transport` | `string` | Active transport (`"stdio"`). |
| `tool_names` | `string[]` | Complete list of registered tool names. |
| `decision_tools_status` | `"complete" \| "partial"` | Status of specification decision tools (`"complete"` in this build). |
| `planned_tools` | `string[]` | Tools from the specification that are not yet served (`[]` in this build). |
| `safety_check` | `string` | Always the literal `"advisory"`. |

### Example call
```json
{}
```

### Example result
```json
{
  "server": "browserreflex",
  "version": "0.1.0",
  "transport": "stdio",
  "tool_names": [
    "server_status",
    "decide",
    "page_check",
    "submit_answers",
    "action_guard",
    "feedback",
    "get_pending_reviews",
    "get_stats"
  ],
  "decision_tools_status": "complete",
  "planned_tools": [],
  "safety_check": "advisory"
}
```

---

## `decide`

### Purpose
Evaluates a batch of typed decisions (`choice`, `score`, `check`) for browser automation tasks. In chat mode, checks exact-match fast-path memory first and returns `needs_ai` entries for unknown decisions. In BYOK mode, resolves `needs_ai` decisions through a configured provider adapter when available.

### When to call
Call when facing repeated decisions during page interaction: classifying elements, selecting interaction strategies, evaluating form requirements, or scoring urgency.

### Decision paths
- `memory`: exact input and question hash seen before with confidence >= threshold.
- `pattern`: matched a loaded pattern rule for the question.
- `ai`: resolved via model in BYOK mode (experimental).
- `needs_ai`: returned to the agent in chat mode to reason and answer via `submit_answers`.
- `needs_human`: confidence below threshold or flagged for human review.

### Input fields

| Field | Type | Required | Description |
|---|---|---|---|
| `questions` | `Question[]` | Yes | Array of typed question objects (`choice`, `score`, or `check`). |
| `state` | `any` | No | Snapshot or state of the page/browser (used for memory lookup hash). |
| `context` | `any` | No | Supplemental context for the decisions (used for memory lookup hash). |
| `threshold` | `number` | No | Minimum confidence threshold for memory reuse (between 0.0 and 1.0, default 0.8). |
| `url` | `string` | No | Page URL if not included inside `state`. |

Each item in `questions` must declare:
- `id`: Unique, stable question identifier string (e.g. `"cookie_consent_action"`).
- `type`: `"choice"`, `"score"`, or `"check"`.
- `text`: Human-readable question prompt.
- `options`: Array of `{ id: string, description?: string }` (required for `choice`, max 20 options).
- `scale`: `{ min: number, max: number, step?: number }` (required for `score`).

### Output fields

| Field | Type | Description |
|---|---|---|
| `answers` | `AnswerOutput[]` | Decisions resolved on the fast path or via BYOK adapter. |
| `needs_ai` | `NeedsAiItem[]` | Questions requiring the agent's reasoning and `submit_answers` call. |
| `needs_human` | `NeedsHumanItem[]` | Questions requiring human guidance in conversation. |
| `schema_violations` | `SchemaViolation[]` | Questions that failed validation against the schema. |

Each item in `answers` includes:
- `id`: Question ID.
- `type`: `"choice" \| "score" \| "check"`.
- `value`: Typed answer value (`string \| number \| boolean`).
- `distribution`: Optional record of choice probabilities.
- `confidence`: Confidence score (0.0 to 1.0).
- `path`: Decision path (`"memory" \| "pattern" \| "check" \| "ai"`).
- `pattern_id`: Pattern ID if answered by a rule.
- `latency_ms`: Execution latency in milliseconds.
- `decision_id`: Unique UUID identifying this recorded decision.

Each item in `needs_ai` includes:
- `id`: Question ID.
- `type`: `"choice" \| "score" \| "check"`.
- `decision_id`: Unique UUID to provide when calling `submit_answers`.
- `text`: Question text prompt.
- `question`: Full original question definition.

### Example call
```json
{
  "questions": [
    {
      "id": "cookie_action",
      "type": "choice",
      "text": "How should the cookie banner be handled?",
      "options": [
        { "id": "accept", "description": "Accept all cookies" },
        { "id": "reject", "description": "Reject non-essential cookies" },
        { "id": "dismiss", "description": "Close without choosing" }
      ]
    }
  ],
  "state": {
    "url": "https://example.com/shop",
    "dialog": "cookie_banner"
  },
  "context": "Initial visit to e-commerce storefront"
}
```

### Example result (unknown question in chat mode)
```json
{
  "answers": [],
  "needs_ai": [
    {
      "id": "cookie_action",
      "type": "choice",
      "decision_id": "4b6f1234-5678-4abc-9def-0123456789ab",
      "text": "How should the cookie banner be handled?",
      "question": {
        "id": "cookie_action",
        "type": "choice",
        "text": "How should the cookie banner be handled?",
        "options": [
          { "id": "accept", "description": "Accept all cookies" },
          { "id": "reject", "description": "Reject non-essential cookies" },
          { "id": "dismiss", "description": "Close without choosing" }
        ]
      }
    }
  ],
  "needs_human": [],
  "schema_violations": []
}
```

---

## `page_check`

### Purpose
Inspects an entire web page from a redacted accessibility tree or DOM snapshot in a single call. Reports five aspects:
1. `page_type`: Structural classification of the page.
2. `popup`: Detection of dialogs (cookie consent banners, promotional popups) with close controls.
3. `login_wall`: Whether an authentication barrier blocks content.
4. `captcha`: Whether a human verification widget is displayed.
5. `risky_actions`: Interactive elements matching payment, destructive, or outbound rules.

### When to call
Call on each new page navigation or after major DOM updates before interacting with elements.

### Bounds and truncation limits
To prevent unbounded work on complex pages, `page_check` enforces hard bounds (`PAGE_CHECK_BOUNDS`):
- `max_elements`: 400 elements considered.
- `max_element_text_chars`: 256 characters per element.
- `max_page_text_chars`: 8192 characters total page text.
- `max_risky_actions`: 50 risky actions reported.

All bounds and any dropped items are reported in `snapshot.bounds` and `snapshot.truncated`.

### Input fields

| Field | Type | Required | Description |
|---|---|---|---|
| `snapshot` | `string \| object \| array` | Yes | Redacted snapshot: either an object (`{ url, elements: [{ role, text }] }`), an accessibility tree text string (`- role "text"`), or an array of elements. |
| `url` | `string` | No | Page URL (used for URL path and domain matchers if not in snapshot). |

### Output fields

| Field | Type | Description |
|---|---|---|
| `page_type` | `PageCheckAnswer` | Page classification answer (returns `needs_ai` in v1; no browser pack rule targets it). |
| `popup` | `PopupCheckAnswer` | Popup detection, including `kind` and `close_target` (`{ role, text, rule_id }`). |
| `login_wall` | `PageCheckAnswer` | Check answer indicating if a login wall is present. |
| `captcha` | `PageCheckAnswer` | Check answer indicating if a captcha widget is present. |
| `risky_actions` | `RiskyActionReport[]` | Array of risky interactive controls found on the page. |
| `needs_ai` | `NeedsAiItem[]` | Questions no rule answered, formatted for `submit_answers`. |
| `needs_human` | `NeedsHumanItem[]` | Questions routed to human review. |
| `packs` | `PackReport` | Pack loading status, active rule count, and any load errors. |
| `snapshot` | `SnapshotReport` | Snapshot processing metadata, elements considered, and bounds. |
| `safety_check` | `"advisory"` | The safety check is advisory: a risky action is a request for the user, not a block. |
| `latency_ms` | `number` | Total processing time in milliseconds. |

Each item in `risky_actions` contains:
- `risk`: `"payment" \| "destructive" \| "outbound" \| null`.
- `action`: `"ask_user" \| "block"`.
- `element_role`: Accessibility role (e.g. `"button"`).
- `element_text`: Redacted accessible name of the element.
- `rule_id`: Rule ID that flagged the control.
- `confidence`: Confidence score.
- `path`: `"pattern"`.
- `is_safety`: `true` for advisory safety rules.
- `latency_ms`: Latency in milliseconds.
- `decision_id`: Unique UUID logged for this finding.

### Example call
```json
{
  "url": "https://shop.example/checkout",
  "snapshot": {
    "url": "https://shop.example/checkout",
    "elements": [
      { "role": "heading", "text": "Review and Pay" },
      { "role": "button", "text": "Place order" }
    ]
  }
}
```

### Example result
```json
{
  "page_type": {
    "question_id": "browser.check.page_type",
    "value": null,
    "status": "needs_ai",
    "confidence": 0,
    "path": "ai",
    "pattern_id": null,
    "latency_ms": 1,
    "decision_id": "9a012345-6789-4abc-def0-123456789abc",
    "reason": null
  },
  "popup": {
    "question_id": "browser.check.popup_kind",
    "value": "none",
    "status": "answered",
    "confidence": 0.9,
    "path": "pattern",
    "pattern_id": "browser.popup.cookie.none_detected",
    "latency_ms": 1,
    "decision_id": "9a012345-6789-4abc-def0-123456789abd",
    "reason": null,
    "kind": "none",
    "close_target": null,
    "close_target_rule_id": null
  },
  "login_wall": {
    "question_id": "browser.check.login_wall",
    "value": false,
    "status": "answered",
    "confidence": 0.9,
    "path": "pattern",
    "pattern_id": "browser.login_wall.none",
    "latency_ms": 1,
    "decision_id": "9a012345-6789-4abc-def0-123456789abe",
    "reason": null
  },
  "captcha": {
    "question_id": "browser.check.captcha",
    "value": false,
    "status": "answered",
    "confidence": 0.9,
    "path": "pattern",
    "pattern_id": "browser.captcha.none",
    "latency_ms": 1,
    "decision_id": "9a012345-6789-4abc-def0-123456789abf",
    "reason": null
  },
  "risky_actions": [
    {
      "risk": "payment",
      "action": "ask_user",
      "element_role": "button",
      "element_text": "Place order",
      "rule_id": "browser.risky.payment.place_order",
      "confidence": 0.95,
      "path": "pattern",
      "is_safety": true,
      "latency_ms": 1,
      "decision_id": "9a012345-6789-4abc-def0-123456789ac0"
    }
  ],
  "needs_ai": [
    {
      "id": "browser.check.page_type",
      "type": "choice",
      "decision_id": "9a012345-6789-4abc-def0-123456789abc"
    }
  ],
  "needs_human": [],
  "packs": {
    "source": "server_engine",
    "pack_ids": ["browser-cookie-banner", "browser-risky-payment"],
    "rule_count": 33,
    "errors": [],
    "note": "Packs loaded cleanly."
  },
  "snapshot": {
    "source": "elements",
    "url": "https://shop.example/checkout",
    "elements_considered": 2,
    "elements_dropped": 0,
    "elements_ignored": 0,
    "element_text_chars_dropped": 0,
    "page_text_chars_dropped": 0,
    "risky_actions_dropped": 0,
    "truncated": false,
    "bounds": {
      "max_elements": 400,
      "max_element_text_chars": 256,
      "max_page_text_chars": 8192,
      "max_risky_actions": 50
    },
    "note": "Snapshot within bounds."
  },
  "safety_check": "advisory",
  "latency_ms": 2
}
```

---

## `submit_answers`

### Purpose
Receives typed answers from the agent for decisions that previously returned `needs_ai`. Validates each answer against the canonical question schema. Valid answers are recorded in SQLite with path `"ai"` and stored in memory so future occurrences answer on the fast path.

### When to call
Call whenever `decide` or `page_check` returns items in `needs_ai`.

### Input fields

| Field | Type | Required | Description |
|---|---|---|---|
| `answers` | `AnswerItem[] \| Record<string, AnswerItem>` | Yes | Array or map of answers containing `decision_id`, `value`, `confidence`, and optional `distribution`. |
| `threshold` | `number` | No | Confidence threshold (default 0.8). Answers below threshold route to `needs_human`. |

Each item in `answers` must supply:
- `decision_id`: The UUID returned in `needs_ai`.
- `value`: Typed answer value (`string \| number \| boolean`).
- `confidence`: Confidence score (0.0 to 1.0).
- `distribution`: Optional record of option probabilities for choice questions.

### Output fields

| Field | Type | Description |
|---|---|---|
| `answers` | `ValidatedAnswerItem[]` | Validated and stored answers. |
| `needs_human` | `NeedsHumanAnswerItem[]` | Answers accepted but routed to human review due to low confidence. |
| `schema_violations` | `AnswerSchemaViolation[]` | Answers failing schema validation (remain retryable with the same `decision_id`). |
| `errors` | `SubmitAnswerError[]` | Errors such as `"not_found"` or `"already_completed"`. |

### Example call
```json
{
  "answers": [
    {
      "decision_id": "4b6f1234-5678-4abc-9def-0123456789ab",
      "value": "reject",
      "confidence": 0.95,
      "distribution": {
        "accept": 0.05,
        "reject": 0.9,
        "dismiss": 0.05
      }
    }
  ]
}
```

### Example result
```json
{
  "answers": [
    {
      "decision_id": "4b6f1234-5678-4abc-9def-0123456789ab",
      "value": "reject",
      "confidence": 0.95,
      "distribution": {
        "accept": 0.05,
        "reject": 0.9,
        "dismiss": 0.05
      },
      "path": "ai",
      "latency_ms": 3
    }
  ],
  "needs_human": [],
  "schema_violations": [],
  "errors": []
}
```

---

## `action_guard`

### Purpose
Advisory safety gate for a single browser action. Evaluates whether an intended action should be allowed, should ask the user first, or should be blocked.

### When to call
Call immediately before executing any interactive browser action: clicking a button, submitting a form, deleting data, typing text into an input, navigating to a sensitive URL, or running a command.

### Verdicts and safety behavior
- `allow`: Action is considered safe based on evaluated rules.
- `ask_user`: Action requires human user confirmation (e.g. payment, account deletion, bulk purge, sending outbound communication).
- `block`: Action carries critical danger (e.g. credential or credit card number detected in text to be typed, or destructive command such as `rm -rf` or `git reset --hard`).

**The verdict is advisory.** The output explicitly carries `advisory: true`, and the text explanation concludes with the advisory statement. Nothing in this tool stops an agent from acting; real enforcement belongs in the host environment.

**Safety rules cannot be bypassed.** An agent cannot pass parameters like `trusted: true`, `user_approved: true`, or `override` to force an `allow`. Built-in rules and pack safety rules always take precedence. Learned patterns may add caution, but can never remove it.

### Input fields

| Field | Type | Required | Description |
|---|---|---|---|
| `action` | `string` | Yes | Action type: `click`, `submit`, `delete`, `type`, `navigate`, `select`, `upload`, `press`, or `command`. |
| `target` | `string \| TargetObject` | No | Target element text string, or object with `{ role?, text?, name?, selector?, value? }`. |
| `text` | `string` | No | Text the action would enter. Checked for credentials, tokens, and credit card numbers. |
| `value` | `string` | No | Alias of `text`. |
| `url` | `string` | No | Page URL (used for URL path rules like `/checkout` or `/payment`). |
| `snapshot` | `any` | No | Optional redacted page snapshot. |

### Output fields

| Field | Type | Description |
|---|---|---|
| `verdict` | `"allow" \| "ask_user" \| "block"` | Advisory verdict. |
| `reason` | `string` | One-sentence plain explanation for the user, ending with the advisory notice. |
| `rule_ids` | `string[]` | IDs of matching safety rules. |
| `decision_id` | `string` | UUID of the recorded decision. |
| `confidence` | `number` | Confidence score (0.0 to 1.0). |
| `path` | `DecisionPath` | Path that determined the verdict (`"check"` or `"pattern"`). |
| `latency_ms` | `number` | Latency in milliseconds. |
| `advisory` | `true` | Always `true`. |
| `needs_ai` | `boolean` | `true` if an unrecognized action verb fell back to `needs_ai`. |
| `pattern_id` | `string \| null` | Rule ID if answered by a loaded pattern rule. |

### Example call
```json
{
  "action": "click",
  "target": {
    "role": "button",
    "text": "Delete Account"
  },
  "url": "https://example.com/settings/profile"
}
```

### Example result
```json
{
  "verdict": "ask_user",
  "reason": "This looks like a destructive action, and a destructive action always asks the user first. The safety check is advisory: it reports a request for the user and does not stop an agent from acting.",
  "rule_ids": ["browserreflex.safety.destructive.control_text"],
  "decision_id": "1c234567-89ab-4cde-f012-3456789abcde",
  "confidence": 0.95,
  "path": "check",
  "latency_ms": 1,
  "advisory": true,
  "needs_ai": false,
  "pattern_id": null
}
```

---

## `feedback`

### Purpose
Records a correction to an earlier decision made by the server. Feedback confirms the decision in fast-path memory, ensuring subsequent calls for that input serve the corrected value. When the corrected decision originated from a pattern rule, feedback logs an agree or disagree sample and updates the pattern's statistical accuracy.

### When to call
Call when an action failed, when a page check was mistaken, or when the user provides explicit correction.

### Input fields

| Field | Type | Required | Description |
|---|---|---|---|
| `decision_id` | `string` | Yes | UUID of the decision being corrected. |
| `correct_value` | `string \| number \| boolean` | Yes | The verified correct answer value. |
| `source` | `"user" \| "agent"` | No | Who reported the correction (default `"agent"`). |
| `note` | `string` | No | Explanation of why the original decision was wrong. Redacted before storage. |

### Output fields

| Field | Type | Description |
|---|---|---|
| `status` | `"recorded" \| "error"` | Whether the correction was successfully stored. |
| `feedback_id` | `string` | UUID of the feedback entry. |
| `decision_id` | `string` | UUID of the corrected decision. |
| `decision_path` | `string` | Decision path of the original decision. |
| `source` | `"user" \| "agent"` | Feedback source. |
| `previous_value` | `any` | Original answer value. |
| `correct_value` | `any` | New verified value. |
| `memory_confirmed` | `boolean` | `true` if memory now reuses this decision. |
| `pattern` | `FeedbackPatternReport \| null` | Updated pattern statistics if the decision came from a pattern. |
| `error` | `string` | Error code if status is `"error"`. |
| `message` | `string` | Error message if status is `"error"`. |

### Example call
```json
{
  "decision_id": "9a012345-6789-4abc-def0-123456789abd",
  "correct_value": "cookie_banner",
  "source": "user",
  "note": "Banner was small and positioned at bottom right"
}
```

### Example result
```json
{
  "status": "recorded",
  "feedback_id": "7d890123-4567-489a-bcde-f0123456789a",
  "decision_id": "9a012345-6789-4abc-def0-123456789abd",
  "decision_path": "pattern",
  "source": "user",
  "previous_value": "none",
  "correct_value": "cookie_banner",
  "note": "Banner was small and positioned at bottom right",
  "memory_confirmed": true,
  "pattern": {
    "pattern_id": "browser.popup.cookie.none_detected",
    "sample_recorded": true,
    "agreed": false,
    "sample_count": 14,
    "agreed_count": 12,
    "disagreed_count": 2,
    "accuracy": 0.857
  }
}
```

---

## `get_pending_reviews`

### Purpose
Lists decisions currently awaiting human review:
- Decisions whose slow-path answer is pending (`path = 'ai'` and answer = `'pending'`).
- Decisions routed to a human (`path = 'human'`).
- Decisions flagged with `needs_review = 1`.

Items are returned oldest first. All text fields (question, context, URL, answer) are redacted before transmission.

### When to call
Call when querying items that require operator attention or audit.

### Input fields

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"choice" \| "score" \| "check"` | No | Filter by decision type. |
| `older_than_minutes` | `number` | No | Filter to items waiting at least this many minutes (integer >= 0). |
| `limit` | `number` | No | Maximum items to return (1 to 200, default 20). |

### Output fields

| Field | Type | Description |
|---|---|---|
| `items` | `PendingReviewItem[]` | Array of pending review items, oldest first. |
| `matching_count` | `number` | Total items matching filters before `limit` truncation. |
| `returned_count` | `number` | Count of items returned in this response. |
| `limit` | `number` | Page limit applied. |
| `type` | `string \| null` | Decision type filter applied. |
| `older_than_minutes` | `number` | Age filter applied in minutes. |
| `safety_check` | `"advisory"` | The safety check is advisory: nothing here stops an agent from acting. |

Each item in `items` includes:
- `decision_id`: Unique UUID of the decision.
- `decision_type`: `"choice" \| "score" \| "check"`.
- `question`: Redacted question prompt.
- `context`: Redacted context string.
- `url`: Redacted page URL.
- `domain`: Domain name.
- `path`: Decision path.
- `answer`: Current answer (`"pending"` if awaiting model answer).
- `confidence`: Confidence score.
- `latency_ms`: Recorded latency.
- `is_safety`: Whether a safety rule flagged the decision.
- `needs_review`: Whether review was requested.
- `created_at`: ISO-8601 creation timestamp.
- `age_seconds`: Elapsed seconds since creation.
- `reasons`: Array of reasons (`"needs_human" \| "needs_review" \| "pending_needs_ai"`).

### Example call
```json
{
  "type": "choice",
  "limit": 10
}
```

### Example result
```json
{
  "items": [
    {
      "decision_id": "1c234567-89ab-4cde-f012-3456789abcde",
      "decision_type": "choice",
      "question": "Should the agent ask the user before taking this action?",
      "context": "Click button: Delete Account",
      "url": "https://example.com/settings/profile",
      "domain": "example.com",
      "path": "check",
      "answer": "ask_user",
      "confidence": 0.95,
      "latency_ms": 1,
      "is_safety": true,
      "needs_review": true,
      "created_at": "2026-10-04T12:00:00.000Z",
      "age_seconds": 120,
      "reasons": ["needs_review"]
    }
  ],
  "matching_count": 1,
  "returned_count": 1,
  "limit": 10,
  "type": "choice",
  "older_than_minutes": null,
  "safety_check": "advisory"
}
```

---

## `get_stats`

### Purpose
Aggregates decision log metrics for a specified time range and filter: total decisions, breakdown by path, fast-path share, median and 95th percentile latency, and an estimated time-saved metric.

### When to call
Call to inspect server performance, evaluate fast-path utilization, or monitor latency percentiles.

### The time-saved figure is an estimate
The field `time_saved_estimate` computes:
`fast_path_answers * ASSUMED_MODEL_CALL_SECONDS_PER_FAST_ANSWER` (where the constant is 3 seconds).

**This constant is an assumption, not a measurement.** BrowserReflex does not run a model timer during fast-path execution. Every response carries `is_estimate: true`, the constant assumed, the fast-answer count, and a note stating that savings were not measured.

### Input fields

| Field | Type | Required | Description |
|---|---|---|---|
| `range` | `"today" \| "7d" \| "30d"` | No | Time window: `"today"` (local midnight), `"7d"`, or `"30d"` (default `"7d"`). |
| `filter` | `"all" \| "browser"` | No | `"all"` (default) includes every decision; `"browser"` filters to decisions recording a URL or domain. |

### Output fields

| Field | Type | Description |
|---|---|---|
| `range` | `"today" \| "7d" \| "30d"` | Selected range. |
| `filter` | `"all" \| "browser"` | Selected filter. |
| `range_start` | `string` | ISO-8601 UTC timestamp of range start. |
| `range_end` | `string` | ISO-8601 UTC timestamp of range end. |
| `total_decisions` | `number` | Total decisions in range. |
| `fast_path_share` | `number \| null` | Proportion of decisions on fast paths (`memory`, `pattern`, `check`), 0.0 to 1.0. `null` if no decisions exist. |
| `counts_by_path` | `object` | Counts for `memory`, `pattern`, `check`, `ai`, `human`. |
| `fast_path_counts` | `object` | Counts for `memory`, `pattern`, `check`. |
| `median_latency_ms` | `number \| null` | Median latency across all decisions in range. |
| `p95_latency_ms` | `number \| null` | 95th percentile latency (nearest rank). |
| `time_saved_estimate` | `TimeSavedEstimate` | Estimated time saved calculation. |

### Example call
```json
{
  "range": "7d",
  "filter": "all"
}
```

### Example result
```json
{
  "range": "7d",
  "filter": "all",
  "range_start": "2026-09-27T12:00:00.000Z",
  "range_end": "2026-10-04T12:00:00.000Z",
  "total_decisions": 85,
  "fast_path_share": 0.8,
  "counts_by_path": {
    "memory": 40,
    "pattern": 20,
    "check": 8,
    "ai": 15,
    "human": 2
  },
  "fast_path_counts": {
    "memory": 40,
    "pattern": 20,
    "check": 8
  },
  "median_latency_ms": 1.5,
  "p95_latency_ms": 12.8,
  "time_saved_estimate": {
    "seconds": 204,
    "is_estimate": true,
    "basis": "fast_path_answers_times_assumed_model_call_time",
    "fast_answers_counted": 68,
    "assumed_model_call_seconds": 3,
    "note": "Estimate, not measured: fast-path answers in range multiplied by an assumed model-call time. This server did not run a model to compare against."
  }
}
```
