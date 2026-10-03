# BrowserReflex: roadmap

Status: **proposed**. Dates are deliberately not given. Each phase ends with a gate; the next phase does not start until the gate is met and recorded.

## Phase 0: the loop works (spike)

Scaffold, local store, MCP server bootstrap, schema and validator, redaction, decision logging, exact-match memory, `decide` and `submit_answers` in chat mode.
**Gate 1:** a real agent completes a `decide` then `submit_answers` round trip, a second run hits memory, and every decision appears in the log with its path and confidence.

## Phase 1: browser MVP

Pattern engine and pack format, the browser pack, `page_check`, `action_guard`, thresholds and routing, `feedback`, `get_pending_reviews`, `get_stats`, the skill and server instructions, key storage, the local REST API, the `init` command, the UI shell and the five v1 pages (setup wizard, dashboard, review queue, thresholds and safety, engines and keys), and the safety test suite. The UI cards start only after the visual direction is decided.
**Gate 2:** an alpha runs on real browser tasks; the safety suite misses nothing; the fast-path share on day one and the token and time difference with and without BrowserReflex are measured and published, including if it is slower.

## Phase 2: learning

Signal extraction, the browser miner, shadow testing, promotion rules, re-checking, demotion and drift alerts, confidence calibration, analytics (performance, cost, learning) and the "learned today" feed.
**Gate 3:** a learned pattern is promoted by the shadow-test rule on real data, a deliberately wrong pattern is demoted automatically, and fast-path share and accuracy are reported against the targets in the specification.

## Phase 3: bring your own key, and release

BYOK adapter interface and the first provider adapter, then documentation, clean-install proof on each supported operating system, the demo and the release checklist.
**Gate 4:** every item in `RELEASE_CHECKLIST.md` is ticked against a recorded result.

## Later

**v2:** coding pack and its tools, pattern inspector and packs pages, decision replay, live activity, logs, further analytics, more provider adapters. **v3:** reports, REST decide API and webhooks, settings and integrations pages, team mode, community packs.
