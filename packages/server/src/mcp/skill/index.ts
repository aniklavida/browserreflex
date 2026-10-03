/**
 * The agent instruction text served as the MCP server's `instructions` field.
 *
 * Status: **placeholder**. This is the bootstrap text written for the MCP bootstrap
 * card. The full skill described in docs/SPEC.md (a `SKILL.md` and an `AGENTS.md`
 * snippet, one instruction set shipped three ways) is planned for Phase 1, and this
 * module is the place it replaces. It is a TypeScript string rather than a `.md` file
 * so that the compiled server carries it without a copy step.
 *
 * Rules for this text:
 * - It describes only what the running build does. A build that does not serve a tool
 *   must not tell the agent to call it.
 * - It states that the safety check is advisory. Nothing here prevents an agent from
 *   acting; only the agent host's own permission or hook system can.
 * - It never tells an agent to fetch and execute a remote document.
 */
export const SKILL_TEXT = `# BrowserReflex

Status: placeholder instructions. The full skill ships later.

## What this server does now

This build serves six tools: \`server_status\`, \`decide\`, \`submit_answers\`, \`feedback\`, \`get_pending_reviews\` and \`get_stats\`.
- \`server_status\`: reports that this server is running and which tools it serves.
- \`decide\`: general typed decision tool that answers repeated decisions, trying fast-path
  memory first and returning \`needs_ai\` for unknown items.
- \`submit_answers\`: receives the agent's typed answers for \`needs_ai\` items, validates them
  against the schema, and stores them for future fast-path memory lookup.
- \`feedback\`: records a correction to a decision this server made, from the user or from
  the agent. Pass the \`decision_id\` from the earlier call and the value that is actually
  correct. The correction confirms the decision in memory, so the next \`decide\` for the
  same input and question returns the corrected value, and a decision that came from a
  pattern gets one agree or disagree sample recorded against it. Call it whenever the
  answer turned out to be wrong, or when the user corrects it.
- \`get_pending_reviews\`: lists decisions still waiting on a person, with redacted
  context. Call it when you want to know what is outstanding, not to decide anything.
- \`get_stats\`: reports decision counts, the fast-path share, latency percentiles and a
  time-saved figure for a range.

## What it does not do

The remaining tools in the specification (\`page_check\`, \`action_guard\`) are planned
and are not implemented. Do not plan a task around them.

## Reading the numbers

\`get_stats\` counts what the decision log holds. Its fast-path share counts answers that
came from memory, a pattern or a direct check; a model answer is never counted as fast.
Its time-saved figure is an estimate from an assumed model-call time, not a measurement:
this server does not run a model to compare against. Report it as an estimate or not at
all.

## Safety

The safety check is advisory. It reports a request for the user and never prevents an
agent from acting. Real enforcement belongs in the agent host's own permission or hook
system; this server does not replace it. \`feedback\` records a correction and changes no
rule.
`;
