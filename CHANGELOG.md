# Changelog

## Unreleased

- Repository scaffold added: pnpm workspace with packages `server`, `ui` (placeholder), `packs`, `cli`, and `skill`, strict TypeScript configuration, ESLint flat config, Prettier, Vitest, license compliance checker, and CI workflows.
- Specification, architecture and roadmap added. There is no working release yet and the product described in the documentation is planned.
- MCP server bootstrap added: an MCP server over the stdio transport that lists its tools and serves an `instructions` field from placeholder text, with one tool per file discovered by listing the tools directory. The only tool is `server_status`; the decision tools are planned and not implemented.
