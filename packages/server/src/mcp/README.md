# MCP server

The MCP server: stdio transport, the tool registry and the `instructions` field.

## What is here, and what state it is in

| Part | State |
|---|---|
| stdio server entry (`start.ts`), run as `browserreflex-mcp` | **implemented and tested** |
| Tool registry: one `*.tool.ts` file per tool, discovered by directory listing | **implemented and tested** |
| `instructions` field served from placeholder text in `skill/` | **implemented and tested** |
| `server_status` tool | **implemented and tested** |
| `decide`, `page_check`, `submit_answers`, `action_guard`, `feedback`, `get_pending_reviews`, `get_stats` tools | **implemented and tested** |
| HTTP transport | **planned** |
| The full skill text | **planned** (Phase 1) |

The safety check is advisory. Nothing in this server prevents an agent from acting; it
reports a request for the user and real enforcement belongs in the agent host's own
permission or hook system.

## Adding a tool

Create one file under `tools/`, named `<tool_name>.tool.ts` in kebab case (`server_status`
is `server-status.tool.ts`), exporting a `tool` definition (`tools/tool.ts` is the
contract). The registry finds it by listing the directory, so nothing else has to be
edited. A file that does not export a valid definition, or a name declared twice, stops
the server from starting rather than producing a server that serves fewer tools than it
was built with.

## Instructions text

`instructions.ts` serves the text in `skill/index.ts`. It is a TypeScript string rather
than a Markdown file so the compiled server carries it with no copy step; the full skill
(`SKILL.md` and an `AGENTS.md` snippet) is Phase 1 work and replaces it. Text that does not
say the safety check is advisory is refused rather than served, because an agent reads
that field and AGENTS.md requires the wording.

## Running it

```sh
pnpm --filter=@browserreflex/server run build
node packages/server/dist/mcp/start.js
```

stdout carries the protocol and nothing else; diagnostics go to stderr.

`start.ts` loads the browser pattern pack at start-up through the pack loader, so the tools
that answer from its rules have them. A pack that fails to load is a stderr warning and a
`packs.errors` entry in the `page_check` answer; the server still starts and serves the
rules that did load.

To look at it with the official inspector:

```sh
npx @modelcontextprotocol/inspector node packages/server/dist/mcp/start.js
```

## What the tests prove

`packages/server/test/mcp-stdio.test.ts` starts the server as a child process and drives
it with the SDK's own client over stdio: it lists the tools the registry found, compares
the served instructions with the shipped text, checks the handshake identity against
`package.json`, calls `server_status`, and measures the compiled server reaching
`initialize` in under a second. `packages/server/test/tool-registry.test.ts` covers the
discovery and the refusal cases with fixture tool files.

Each decision tool has its own file, and each of those files also drives the tool over a
real MCP client against a temporary database: `decide-tool.test.ts`,
`submit-answers-tool.test.ts`, `action-guard-tool.test.ts` (`action_guard`),
`feedback-tool.test.ts`, `reviews-tool.test.ts` (`get_pending_reviews`), `stats-tool.test.ts`
(`get_stats`) and `page-check-tool.test.ts` (`page_check`).
