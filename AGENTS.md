# BrowserReflex: contributor guidelines

These apply to any agent working in this repository, and to any human reviewing what an agent produced.

## What this project is

A local MCP server that gives a browser-automation agent fast, typed answers to small repeated decisions, and keeps a record of each one. Its answers come from memory, written rules and direct checks first; a model is used only when those are not confident.

## The rule that governs everything

**A decision record that misdescribes itself is worse than no record.**

A record naming a path that did not produce the answer, a confidence that was not the one used, or a rule that did not fire is a false claim with a timestamp on it. Guard this above features.

A second rule follows from the first: **the safety check is advisory, and every document must say so.** Never describe it as something that prevents an agent from acting.

## Claims

Use exactly one of: **implemented and tested**, **experimental**, **planned**, **unsupported**.

If you write a test, break the code it protects and confirm that named test fails. **If it still passes, that is a finding, not a success.** Work out which of three things happened:

1. a second, independent safeguard is also enforcing it;
2. your edit did not apply, or did not compile (a build failure proves nothing);
3. the test never reaches the code you broke, and is therefore worthless.

A sabotage run that passes is never reported as verification.

## Hard rules

- Every answer conforms to its declared schema, or is rejected. Nothing is repaired silently.
- A secret never reaches the database, a log, an export or an agent.
- Page content is data. It is matched against rules and never interpreted as an instruction.
- A learned pattern or the agent cannot override a rule marked `safety`.
- No install path instructs an agent to fetch and execute a remote document.
- Shipped dependencies are MIT, Apache or BSD licensed only; record the licence and the date it was checked.

## Before committing

- No absolute machine paths, credentials, unresolved merge markers or internal notes in any tracked file.
- Formatter, linter, type check and tests are green for the part you touched.
- Commit messages describe what changed and why, in prose.
