# Gate 3: learning verification (template)

Status: **not measured yet**.

This document is a template for recording the Gate 3 alpha evaluation. Per `docs/ROADMAP.md`, Gate 3 concludes Phase 2 (Learning) by proving that a learned pattern is promoted by the shadow-test rule on real data, a deliberately wrong pattern is demoted automatically, and fast-path share and accuracy are reported against the targets declared in `docs/SPEC.md`.

No alpha result has been measured yet. The figures below are targets; the result columns will be filled when real tasks are run.

## Honest limits

- **The safety check is advisory.** An agent that does not call it is not stopped by it. Enforcement belongs in the agent host's own permission or hook system.
- **Faster or cheaper is a measurement, not a promise.** BrowserReflex reports what is observed on real tasks, including cases where it is slower or where the fast-path share is low.

## Method

The Gate 3 evaluation is conducted on real browser-automation tasks (such as repeated site navigation, form submission, and monitoring):

1. **Baseline run:** Execute browser tasks with BrowserReflex logging decisions without pre-trained learned patterns. Capture slow-path decisions and signal attributes.
2. **Mining & Shadow testing:** The pattern miner identifies agreeing decisions across domains, paths, and element roles. Mined candidate patterns are written to the pattern store with status `shadow`. In shadow testing, candidate rules evaluate snapshots concurrently with slow-path execution without overriding answers.
3. **Promotion (planned, not built yet):** A shadow pattern that satisfies promotion criteria (minimum sample count and agreement threshold) is promoted to active fast path.
4. **Monitoring & Demotion (planned, not built yet):** A random sample of fast-path answers is re-checked against slow-path evaluation. A pattern that exhibits accuracy drift below its threshold is automatically demoted.
5. **Measurement:** The `browserreflex report` command is executed against the local decision log to extract fast-path shares, daily trends, time saved estimates, pending reviews, and candidate counts.

## How to run the measurement command

The report command is built into the CLI package and operates in read-only mode against the local decision database:

```bash
# Print formatted measurement report for all recorded decisions
browserreflex report

# Report over the last 14 days (two weeks)
browserreflex report --since 14

# Output machine-readable JSON
browserreflex report --since 14 --json

# Point to an explicit database location
browserreflex report --db ./path/to/browserreflex.db
```

## Results table

| Measure | Specification target | Measured alpha result | Status |
|---|---|---|---|
| Fast-path share on day one | 30% or more | — | not measured yet |
| Fast-path share over two weeks | rising trend | — | not measured yet |
| Fast-path share after four weeks | 70% or more | — | not measured yet |
| Fast-path accuracy | 97% or more | — | not measured yet |
| Safety rules missed | 0 | — | not measured yet |
| Median fast-decision latency | under 10 ms | — | not measured yet |
| P95 fast-decision latency | under 25 ms | — | not measured yet |
| Shadow pattern promoted on real data | at least 1 pattern | — | not measured yet |
| Drift demotion verified on real data | at least 1 pattern | — | not measured yet |
| Token difference per task | 25% saving or more | — | not measured yet |

When the alpha evaluation takes place, actual command output from `browserreflex report --since 14` and raw measurements will be recorded in this file.
