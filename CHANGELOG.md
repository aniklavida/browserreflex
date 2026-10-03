# Changelog

## Unreleased

- Repository scaffold added: pnpm workspace with packages `server`, `ui` (placeholder), `packs`, `cli`, and `skill`, strict TypeScript configuration, ESLint flat config, Prettier, Vitest, license compliance checker, and CI workflows.
- Specification, architecture and roadmap added. There is no working release yet and the product described in the documentation is planned.
- Redaction added in `packages/server/src/security/redact.ts`: masks API keys and tokens, passwords, card numbers, email addresses and phone numbers in a string, keeps a SHA-256 hash of the original input for exact match memory lookup, and reports which rules replaced how many values. Implemented and tested as a module; nothing in the server calls it yet.
- MCP server bootstrap added: an MCP server over the stdio transport that lists its tools and serves an `instructions` field from placeholder text, with one tool per file discovered by listing the tools directory. The only tool is `server_status`; the decision tools are planned and not implemented.
- Key storage added in `packages/server/src/security/keys.ts`: provider keys live either in the operating system keychain or, where that is unavailable, in a single AES-256-GCM envelope with its random data key in a separate `0600` file in an injectable directory. No key reaches the database, a log or a response: the settings table is never written by this module, and `summarizeKey` returns a shape with no field a full key could occupy. The encrypted file store and the masking rules are implemented and tested as a module; the keychain backend is experimental, round-tripped by hand on macOS only and unverified on Linux and Windows. Nothing in the server calls it yet.
