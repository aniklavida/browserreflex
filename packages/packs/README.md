# @browserreflex/packs

Pattern pack JSON schema, manifest definitions, and example packs for BrowserReflex.

Status: **implemented and tested**.

The safety check is advisory; it never prevents an agent from acting.

## Pack format

A pattern pack is a versioned YAML document containing a manifest and a list of rules matching the engine's `Rule` type:

- Manifest: `id`, `name`, `version`, optional `description`, `source` (`builtin` or `community`), and a placeholder `signature` (reported as `unsigned`; verified signatures are planned).
- Rules: `id`, `matchers`, `output`, optional `name`, `description`, `safety` flag and `confidence`.

Validating JSON schema is provided in `schema.json`.
