# BrowserReflex

**Fast, typed answers to the small decisions a browser agent makes again and again, with a record of every one.**

BrowserReflex is a self-hosted MCP server with a small local web UI. It sits beside a browser-automation agent. For repeated small questions (what kind of popup is this, is this button safe to click, is a login wall in the way) it answers from remembered inputs, written rules and direct checks of the page. When none of those is confident enough, the question goes to the agent's own model, and that answer is stored so the next occurrence is fast.

> **Status: planned.** This repository currently contains the repository scaffold, specification, architecture and roadmap. There is no working release, and the product described below is planned. The name is a working name.

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
| MCP tools: `decide`, `submit_answers`, `action_guard`, `feedback`, `get_pending_reviews`, `get_stats` | implemented and tested |
| MCP tool: `page_check` | planned |
| Browser pattern pack (cookie banner, popups, login wall, captcha, payment, destructive and outbound actions) | rules and synthetic fixtures implemented and tested; `action_guard` serves the three risky families, and `page_check` is planned |
| Learning loop: capture, mine, shadow test, promote, re-check, demote | planned |
| Chat mode (no key) and bring-your-own-key mode | planned |
| Local UI: setup wizard, dashboard, review queue, thresholds and safety, engines and keys | planned |
| Coding pack, analytics, reports, integrations, team mode, community packs | planned for later versions |
| Enforcement of safety rules inside agent hosts | unsupported |

## Documents

- [Specification](docs/SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Design](docs/DESIGN.md)
- [Release checklist](docs/RELEASE_CHECKLIST.md)

## Licence

MIT. See [LICENSE](LICENSE).
