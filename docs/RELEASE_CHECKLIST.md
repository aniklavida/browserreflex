# BrowserReflex: release checklist

A box is ticked only against a recorded result (a passing test name, a CI run, a measured number with its hardware). The release stays blocked while any safety or truthfulness issue is open.

## Product

- [ ] A fresh install on each supported operating system reaches a first decision in under five minutes.
- [ ] The safety suite blocks every payment, destructive and outbound case, and misses none.
- [ ] A forced wrong pattern is demoted automatically.
- [ ] Fast-path share, accuracy, latency and token difference are measured on real browser tasks and reported as measured, whether or not they meet the targets.
- [ ] Page content cannot change a rule (prompt-injection fixtures pass).
- [ ] No key, token or personal data appears in the database, logs or exports.

## Documentation and claims

- [ ] Every capability in the README carries exactly one of: implemented and tested, experimental, planned, unsupported.
- [ ] The advisory nature of the safety check is stated wherever the check is described.
- [ ] No performance figure is stated without the setup it came from.

## Dependencies

- [ ] Every shipped dependency is MIT, Apache or BSD licensed, with the licence and the verification date recorded.

## Repository

- [ ] CI is green on the release commit.
- [ ] No local path, credential or internal note in any tracked file.
- [ ] Tag, package publication and release notes are created only when the owner asks.
