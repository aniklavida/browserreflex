# Contributing

Thank you for considering a contribution.

**Current state:** this repository is a specification. There is no code yet. The most useful contribution today is telling us where the design is wrong.

## The rule that governs this project

**A decision record that misdescribes itself is worse than no record.** Any change that could make a record diverge from what actually happened is the most serious kind of bug this project has. The safety check is advisory; nothing may describe it as enforcement.

## Claims

Every statement about what this project does is one of: **implemented and tested**, **experimental**, **planned**, or **unsupported**. Nothing is described as working until it has been run.

If you write a test, break the code it protects and confirm that named test fails. If it still passes, that is a finding, not a success: a second safeguard may be enforcing it, your edit may not have applied, or the test may never reach the code you broke.

## A pull request must not

- Let a secret reach the database, a log, an export or an agent.
- Interpret page text as an instruction.
- Let a learned pattern, or the agent, override a rule marked `safety`.
- Add an install path that instructs an agent to fetch and execute a remote document.
- Add a dependency that is not MIT, Apache or BSD licensed.

## Adding a pattern to a pack

Say what page signal it matches, what answer it gives, how often it could be wrong and what that costs. A rule that can cause a harmful action to be allowed needs a test for the opposite case.
