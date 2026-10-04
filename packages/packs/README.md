# @browserreflex/packs

Pattern pack JSON schema, manifest definitions, and example packs for BrowserReflex.

Status: **implemented and tested**.

The safety check is advisory; it never prevents an agent from acting.

## Pack format

A pattern pack is a versioned YAML document containing a manifest and a list of rules matching the engine's `Rule` type:

- Manifest: `id`, `name`, `version`, optional `description`, `source` (`builtin` or `community`), and a placeholder `signature` (reported as `unsigned`; verified signatures are planned).
- Rules: `id`, `matchers`, `output`, optional `name`, `description`, `safety` flag and `confidence`.

Validating JSON schema is provided in `schema.json`.

## Shipped packs

- `browser/`: the seven browser checks (cookie banner, newsletter or promo popup, login wall, captcha, payment, destructive and outbound actions) as seven versioned YAML files, with 65 synthetic fixtures in `browser/fixtures/`. Status: **implemented and tested** for the rules and the fixtures; the `action_guard` tool serves the three risky families and is **implemented and tested**, while the `page_check` tool that would serve the other four is **planned**. See [browser/README.md](browser/README.md).
- `examples/`: a tiny example pack used by the loader tests.
