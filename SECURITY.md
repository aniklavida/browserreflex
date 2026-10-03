# Security policy

## Reporting

Report a security issue through GitHub's private vulnerability reporting on this repository. Please do not open a public issue for something that could be exploited before it is fixed.

## What this project handles that is worth attacking

**Provider keys.** In bring-your-own-key mode a key for a model provider is stored. Anything that causes it to be written to the database, a log, an export or shown to an agent is a serious vulnerability.

**The safety rules.** A way for an agent, a page or a learned pattern to disable or override a rule marked `safety` is a vulnerability.

**Page content.** Text on a page must be treated as data. A way for page text to change a decision rule, or to be run as an instruction, is a vulnerability.

**The local UI.** It listens on localhost only by default. A way to reach it from another machine without the user choosing to is a vulnerability.

## Stated limits, not vulnerabilities

- The safety check is advisory. An agent that never calls it is not stopped by it. Pair it with the agent host's own permission or hook system for enforcement.
- A site changing its layout and a pattern becoming wrong. The project detects this through re-checks and drift alerts and says so.

## What this project will not do, by design

No install path instructs an agent to fetch and execute a remote document. No data leaves the machine unless the user opts in.
