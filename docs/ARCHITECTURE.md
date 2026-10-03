# BrowserReflex: architecture

Status: **planned**. This describes the intended design; no component exists yet.

## Shape

One local process runs the MCP server, the pattern engine, the learning store and the web UI. The agent only ever talks to the MCP server. The UI and the store never leave the machine.

| Component | Responsibility |
|---|---|
| MCP server | Exposes the tools, validates every input and output against the schema, routes a decision to a path, writes the log |
| Pattern engine | Matches written rules and learned patterns against the supplied snapshot; runs direct checks |
| Memory | Returns a stored answer for an input seen before (exact hash match) |
| Provider adapter | In chat mode, hands the question back to the agent; in BYOK mode, calls the user's configured provider |
| Learning store | SQLite: decisions, feedback, patterns, pattern statistics, packs, settings |
| Pattern miner | Turns repeated slow answers into candidate patterns, shadow tests them, promotes or demotes |
| Local UI | Setup, review, thresholds and safety, engines and keys; served from the same process on localhost |

## Decision flow

1. The agent calls a tool with a redacted snapshot or typed questions.
2. The server validates the input and redacts anything secret before it is stored.
3. Routing tries, in order: memory, safety rules, patterns and direct checks. A confident answer returns immediately.
4. Otherwise the decision goes to the slow path (`needs_ai` in chat mode, or a provider call in BYOK mode) or to a human when confidence is under the threshold or a safety rule fired.
5. The answer is validated; an invalid answer is rejected.
6. The decision is logged with its path and confidence. Slow answers and corrections feed the miner.

## Boundaries that must hold

- **Schema first.** No answer leaves the server unless it matches its declared type.
- **Safety rules are not learned away.** A learned pattern cannot override a rule marked `safety`, and neither can the agent.
- **Advisory, not enforcing.** The server cannot stop an agent that never calls it. Anything that needs real enforcement belongs in the agent host's own permission or hook system; this project documents how to pair with it and does not claim to replace it.
- **Page content is data.** Text from a page is matched against rules and never interpreted as an instruction.
- **Secrets stay out.** Keys live in the operating system keychain; redaction runs before anything is stored or logged.

## Data

One SQLite file with seven tables (`sessions`, `decisions`, `feedback`, `patterns`, `pattern_stats`, `packs`, `settings`). Inputs are stored redacted. Default retention is 30 days.

## Extension points

Pattern packs (versioned YAML, signed), provider adapters, and later browser adapters that read a page from a browser MCP server directly.
