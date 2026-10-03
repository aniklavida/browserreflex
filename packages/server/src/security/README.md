# Security

Redaction of secrets, advisory safety rules, and immutable audit logs.

## Redaction

`redact.ts` is **implemented and tested** as a module. It masks API keys and
tokens, passwords, card numbers, email addresses and phone numbers in a string,
and keeps a SHA-256 hash of the original input so that a decision can be
recognised on a later run while the stored text stays redacted. The test is
`packages/server/test/redact.test.ts`: fifty fixtures plus a set of awkward
shapes, each checked for leaks in any spelling, plus a measured cost check.

What is **not** done: nothing calls `redact` yet. Wiring it into the store, the
log and the exports is planned, and until that exists the claim is about the
module and not about the server. Reading the hash as protection against someone
who already holds the database is also not a claim this module makes; the limit
is recorded on the function itself.

Advisory safety rules and the immutable audit log are **planned**. The safety
check is advisory: it never prevents an agent from acting.