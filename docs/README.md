# BrowserReflex documentation

An index of the available documentation for BrowserReflex.

---

## Guides

| Document | What it covers |
|---|---|
| [QUICKSTART.md](QUICKSTART.md) | Install from source, run `browserreflex-mcp init`, check `server_status`, chat mode vs BYOK mode, `browserreflex report` |
| [TOOLS.md](TOOLS.md) | Tool reference for all eight served MCP tools: purpose, input fields, output fields, decision paths, example call and result |
| [PACKS.md](PACKS.md) | Pack authoring guide: YAML shape, matchers, safety flag, specificity and precedence, fixtures and how to add a rule |

## Specification and design

| Document | What it covers |
|---|---|
| [SPEC.md](SPEC.md) | Full product specification |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System architecture, component map, data flows |
| [DESIGN.md](DESIGN.md) | Design decisions and rationale |
| [ROADMAP.md](ROADMAP.md) | Planned milestones and future direction |
| [DEPENDENCIES.md](DEPENDENCIES.md) | Dependency licence audit |

## Operations

| Document | What it covers |
|---|---|
| [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) | Steps to follow before tagging a release |
| [gate3.md](gate3.md) | Gate 3 alpha evaluation template (result: not measured) |

---

## Honest limits that apply throughout

- **The safety check is advisory.** An agent that does not call it is not stopped by it. Real enforcement belongs in the agent host's own permission or hook system.
- **Faster or cheaper is a measurement, not a promise.** Token and time differences are unmeasured; reported time savings are estimates labelled as such.

Every feature statement in this documentation is exactly one of: **implemented and tested**, **experimental**, **planned**, or **unsupported**. Consult the capability table in the [root README](../README.md) for the current state of each feature.
