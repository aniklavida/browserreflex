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

Status: placeholder instructions for the bootstrap build. The full skill ships later.

## What this server does now

This build serves one tool, \`server_status\`, which reports that the server is running and
which tools it serves. Call it when you want to confirm the server is up.

## What it does not do

The tools in the specification (\`decide\`, \`submit_answers\`, \`page_check\`,
\`action_guard\`, \`feedback\`, \`get_pending_reviews\`, \`get_stats\`) are planned and are not
implemented. Do not plan a task around them.

## Safety

The safety check is advisory. It reports a request for the user and never prevents an
agent from acting. Real enforcement belongs in the agent host's own permission or hook
system; this server does not replace it.
`;
