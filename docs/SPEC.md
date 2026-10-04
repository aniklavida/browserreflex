# BrowserReflex: specification

Status: **planned**. Nothing described here is implemented yet. The product name is a working name.

## Summary

BrowserReflex is a self-hosted MCP server, with a small local web UI, that gives a browser-automation agent fast, typed answers to the small decisions it makes again and again: what kind of popup is this, is this button safe to click, is a login wall in the way. It is not a model. Answers come from remembered inputs, written rules and direct checks of the page; only when none of those is confident enough does the decision go to the agent's own model (or one the user configures), and that slow answer is stored so the next occurrence is fast.

- **What it is:** a decision layer beside the agent, with a record of every decision.
- **What it is not:** a new language model, a browser, or a replacement for the agent's judgement on anything that is not a repeated small decision.

## Who it is for and the problem

**Primary user (v1):** a person or team running browser agents at volume (for example price collection, form filling, monitoring) through an MCP-capable agent such as Claude in Chrome, a Playwright-based MCP server or similar.

**Problem:**

- Every page brings small repeated decisions. The agent spends a full model call on each, which is slow and costs tokens.
- Nothing is learned between sessions. A cookie banner solved yesterday is solved again today.
- Safety instructions (never pay, never delete without asking) drift out of a long task.
- After a session there is no record of why each decision was taken.

**Secondary user (v2):** developers using coding agents (risk of a diff, test failure kind, task completion).

## Honest limits

- The safety check is **advisory**. An agent that does not call it is not stopped by it. Enforcement needs a host-side control (the agent host's own permission or hook system) and the documentation will say so wherever the check is mentioned.
- Whether BrowserReflex makes a given workflow faster or cheaper is an open measurement, not a promise. The first release must report the measured fast-path share and token difference on real tasks, including the case where it is slower.

## Core concept

Each decision has one of three typed forms, and every answer carries its confidence and the path it came from.

- **Choice:** one option from a list (at most 20), with a probability for each.
- **Score:** a value on an ordered scale.
- **Check:** yes or no with a probability.

Three paths:

1. **Fast path (target a few milliseconds):** exact input seen before (memory), a matching rule or learned pattern (pattern), or a direct check of the supplied page data (check).
2. **Slow path (seconds):** no confident fast answer; the agent's own model, or a configured provider, answers with a typed distribution.
3. **Human:** confidence under the configured threshold, or a safety rule fired.

Rules that hold everywhere:

- Output always conforms to the schema. An invalid answer is rejected, not repaired.
- Every answer states its confidence and path (memory, pattern, check, ai, human).
- Safety rules cannot be disabled by the agent; only the user can change them, in the UI, with an audit entry.
- Every decision is logged locally, with secrets redacted before storage.

## Learning loop

A slow answer becomes a fast one in five steps: capture, mine, shadow test, promote, monitor.

1. **Capture** every slow answer (model or human) with input, question, answer and confidence.
2. **Mine** repeated answers for a common signal: domain, URL path, element selector and text.
3. **Shadow test:** the candidate pattern runs silently while the slow path still answers; agreement is recorded.
4. **Promote** to the fast path after enough agreeing samples. Defaults (to be tuned on real data): 20 samples at 95% agreement; for safety-related patterns 50 samples at 99%.
5. **Monitor and demote:** a random share of fast answers (default 2%) is re-checked on the slow path; a pattern whose accuracy falls below its threshold is disabled automatically and a drift alert is shown.

Confidence is calibrated per pattern and decision type from user feedback.

## Scope

### v1: browser first

| Area | Content |
|---|---|
| MCP tools | `decide`, `submit_answers`, `page_check`, `action_guard`, `feedback`, `get_pending_reviews`, `get_stats` |
| Pattern pack | Browser pack (below) |
| Modes | Chat mode (no key) and BYOK mode (user's own provider key) |
| Learning | Capture, mine, shadow test, promote, monitor, demote |
| Local UI | Setup wizard, dashboard, review queue, thresholds and safety, engines and keys |
| Data | Local SQLite, redaction, retention |

### v2

Coding pack (`diff_risk`, `test_result`, `task_done`, `relevant_files`), pattern inspector, pattern packs page, decision replay, live activity, logs, analytics beyond performance, cost and learning, an optional small local statistical classifier trained on the user's own data.

### v3

Reports, integrations (REST API and webhooks), team mode with roles, community packs (opt-in, signed).

### Not doing

A new or pretrained model, hosted accounts, telemetry by default, enforcement of safety inside agent hosts.

## How page content reaches BrowserReflex

Proposed for v1, pending approval: the agent passes a **redacted snapshot** (element roles and text, input types, visible dialogs, the URL) in the `page_check` or `action_guard` call. BrowserReflex does not read the browser itself. Adapters that read from a browser MCP server directly are a later option. Page content is treated as data only; text on a page cannot change a rule.

## Browser pack (v1)

| Check | Signal | Result |
|---|---|---|
| Cookie banner | Known consent-library element, "accept cookies" text | popup `cookie_banner`, close target |
| Newsletter or promo popup | Modal with an email input and a close control | popup `promo` |
| Login wall | Password input, "sign in to continue" text, redirect to a login path | `login_wall: true` |
| Captcha | Known captcha frame or widget | `captcha: true`, ask the user |
| Payment action | "Buy now", "Checkout", "Place order", "Pay" and localised forms | risky `payment`, ask the user |
| Destructive action | "Delete", "Remove account", "Unsubscribe all" | risky `destructive`, ask the user |
| Send or publish | "Send", "Post", "Publish" on mail or social sites | risky `outbound`, ask the user |

Packs are versioned YAML rules. Rules marked `safety: true` cannot be disabled by the agent.

## Modes

- **Chat mode (no key):** when no confident fast answer exists, BrowserReflex returns `needs_ai`; the agent thinks, then sends typed answers with `submit_answers`, which are validated.
- **BYOK mode:** BrowserReflex calls the user's configured provider itself. Suited to unattended runs. Keys are held in the operating system keychain, never in the database, logs or exports.

## MCP tools (v1)

| Tool | Input | Output |
|---|---|---|
| `decide` | state, questions (choice, score or check), context | answers, or `needs_ai` / `needs_human` entries |
| `submit_answers` | decision ids, answers with distributions | validated answers |
| `page_check` | URL and redacted page snapshot | page type, popup, login wall, captcha, risky actions |
| `action_guard` | action, target element, URL | `allow`, `ask_user` or `block`, with reason |
| `feedback` | decision id, correct value, note | acknowledgement and pattern update |
| `get_pending_reviews` | filter | review items |
| `get_stats` | range, filter | fast-path share, time, token difference |

Every answer includes `decision_id`, `confidence`, `path` and, when applicable, `pattern_id` and `latency_ms`.

## Skill

One short instruction set ships three ways so any agent can use it: a `SKILL.md`, an `AGENTS.md` snippet and the MCP server's own `instructions` field. It tells the agent when to call BrowserReflex (on each new page, before any click, submit or delete), when to think for itself, how to write questions, what to do on `needs_ai`, and that an `ask_user` result is never skipped.

## Local UI

Served from the same process on `127.0.0.1`. English only. Dark by default with a light theme. Safety prompts are never UI popups: `ask_user` happens in the agent's own conversation and the UI records the event and the user's answer. A "Local only" indicator is visible on every page.

v1 pages: setup wizard (agent, mode, packs, test decision), dashboard (fast-path share over time, items needing review, safety stops, path mix, drift alert), review queue (one item at a time, keyboard first), thresholds and safety, engines and keys. Every empty page says what will appear and what to do next. Confidence colours are reserved: green for automatic, amber for model, red for human or safety.

The visual direction (tokens, typography, components, pages and behaviour) is in [DESIGN.md](DESIGN.md).

## Data model

One local SQLite file with seven tables: `sessions`, `decisions`, `feedback`, `patterns`, `pattern_stats`, `packs`, `settings`. Inputs are redacted before storage; default retention is 30 days.

## Technology

| Part | Choice |
|---|---|
| Server | TypeScript, official MCP SDK, stdio and HTTP transports |
| Storage | SQLite |
| Pattern engine | JSON or YAML rules, regular expressions, text and selector matching on the snapshot |
| UI | React and Vite served from the same process |
| Provider adapters (BYOK) | Anthropic, OpenAI, Gemini, OpenRouter, Ollama |
| Key storage | Operating system keychain, encrypted-file fallback |
| Distribution | npm (`npx`), optional container |

Every shipped dependency must be MIT, Apache or BSD licensed.

BYOK mode sends its default model in one place: the Anthropic adapter uses `claude-haiku-4-5-20251001`, the fast and cheap Haiku class model, named once in code as `DEFAULT_ANTHROPIC_MODEL` and overridable in settings. The Anthropic adapter is **implemented and tested** against recorded fixtures, with no test reaching the live API; the other adapters are **planned**. A provider call is bounded by a timeout and a bounded retry on 429 and 5xx, never on a 4xx authentication error, and the key is read from the operating system keychain at call time and never logged, returned or quoted in an error.

## Security and privacy

- Local-first: data, logs and patterns stay on the user's machine; no telemetry unless the user opts in.
- Redaction of keys, tokens, passwords, card numbers, phone numbers and emails before a decision is stored.
- Safety rules for payment, deletion, outbound sending, force push and secret leakage cannot be disabled by the agent or by a learned pattern.
- Prompt injection: page text is data. A page saying "ignore the rules" changes nothing.
- Packs are signed; installing an unsigned pack warns.
- The UI listens on localhost only by default.
- Safety decisions and setting changes go to an audit log that is not editable from the UI.

## Success measures for v1

Targets, to be tuned on real data and reported honestly whether or not met:

| Measure | Target |
|---|---|
| Fast-path share on day one, browser tasks | 30% or more |
| Fast-path share after four weeks of use | 70% or more |
| Fast-path accuracy | 97% or more |
| Safety rules missed in the test suite | 0 |
| Median fast-decision latency | under 10 ms |
| Token difference per browser task, measured with and without | 25% saving or more |
| Setup time | under 5 minutes |

## Risks

| Risk | Mitigation |
|---|---|
| Extra tool calls make the first week slower | Batch checks into one call; call only where it pays; measure |
| The agent forgets to call it | Skill plus server instructions; keep the safety call light |
| A wrong pattern is promoted | Shadow test, 2% re-check, automatic demotion |
| Sites change and patterns break | Drift alerts, fall back to the slow path |
| Prompt injection through page text | Page content is data; safety rules are fixed in code |
| Savings are hard to measure | Run tasks with and without it and publish both |

## Open questions

- Final product name and repository name.
- Whether the page snapshot comes from the agent (proposed) or from a browser adapter.
- Whether a model the user did not choose can be trusted for a decision it is confident
  about: the default for BYOK mode is settled (`claude-haiku-4-5-20251001`), the confidence
  that model reports about itself is not calibrated by anything in this project.
- Who the first alpha users are.
