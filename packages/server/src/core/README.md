# Core

Decision logging, schema validation, memory lookup, and core routing logic.

## Status

- Decision schema and validator (`schema.ts`): **implemented and tested**.
- Exact-match memory (`memory.ts`): **implemented and tested**.
- Decision logging and session tracking (`log.ts`): **implemented and tested**.
- Decision router (`router.ts`): **implemented and tested** for exact-match memory and needs_ai fallback.
- Pattern routing and provider adapters: **planned**.

## Invariants

- **Decision records describe what happened:** A decision record states the path and confidence that actually produced the answer.
- **Redaction before storage:** Secrets and personal data are masked before anything is written to disk, and the original input hash is stored for exact-match memory lookup.
- **The safety check is advisory:** Safety checks provide advisory review signals and do not stop an agent from acting.
- **Session tracking:** Every decision belongs to a session, detected per MCP connection.
