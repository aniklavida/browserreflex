# BrowserReflex

**Fast, typed answers to the small decisions a browser agent makes again and again, with a record of every one.**

BrowserReflex is a self-hosted MCP server with a small local web UI. It sits beside a browser-automation agent. For repeated small questions (what kind of popup is this, is this button safe to click, is a login wall in the way) it answers from remembered inputs, written rules and direct checks of the page. When none of those is confident enough, the question goes to the agent's own model, and that answer is stored so the next occurrence is fast.

> **Status: pre-release.** The server core, all eight MCP tools, the browser pattern pack, the CLI commands (`init`, `serve`, `report`), and the advisory safety suite are **implemented and tested**. The local web UI and Docker support are **planned**. There is no stable release yet; see the capability table below for the state of each feature.

## What it is, and what it is not

| It is | It is not |
|---|---|
| A decision layer beside the agent | A new or pretrained language model |
| Typed answers with a confidence and the path they came from | A browser, or a replacement for the agent's judgement on anything that is not a small repeated decision |
| A local record of every decision, with secrets redacted | A hosted service or something that sends data out |

## Honest limits

- **The safety check is advisory.** An agent that does not call it is not stopped by it. Real enforcement belongs in the agent host's own permission or hook system, and the documentation will say so wherever the check appears.
- **Faster or cheaper is a measurement, not a promise.** The first release will publish the measured fast-path share and the token and time difference with and without BrowserReflex on real tasks, including if it turns out slower.

## Planned for v1: browser first

| Capability | State |
|---|---|
| MCP tools: `decide`, `submit_answers`, `feedback`, `get_pending_reviews`, `get_stats` | implemented and tested |
| `page_check` | implemented and tested |
| `action_guard` | implemented and tested (advisory) |
| Skill (`SKILL.md`), `AGENTS.md` snippet and MCP instructions | implemented and tested as text and drift-checked; agent adherence: not measured |
| Browser pattern pack (cookie banner, popups, login wall, captcha, payment, destructive and outbound actions) | rules and synthetic fixtures implemented and tested; served by `page_check` and, for the three risky families, `action_guard` |
| Advisory safety test suite (payment, destructive, outbound, secrets, prompt injection, benign) | implemented and tested (193 cases, 30 property tests, 0 misses) |
| Learning loop: capture, mine, shadow test, promote, re-check, demote | capture, miners, calibration, shadow test and promotion implemented and tested; re-check and demote planned |
| Chat mode (no key) and bring-your-own-key mode | experimental (fixture-tested only) |
| Local UI: setup wizard, dashboard, review queue, thresholds and safety, engines and keys | planned |
| Measurement report command (`browserreflex report`) | implemented and tested |
| Gate 3 alpha evaluation | not measured |
| Coding pack, analytics, reports, integrations, team mode, community packs | planned for later versions |
| Enforcement of safety rules inside agent hosts | unsupported |

## Documents

- [Documentation index](docs/README.md)
- [Quickstart](docs/QUICKSTART.md)
- [Tools reference](docs/TOOLS.md)
- [Pack authoring guide](docs/PACKS.md)
- [Specification](docs/SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Gate 3 verification template](docs/gate3.md) (result: not measured)
- [Design](docs/DESIGN.md)
- [Release checklist](docs/RELEASE_CHECKLIST.md)

## Licence

MIT. See [LICENSE](LICENSE).
