# Advisory safety test suite

A data-driven test suite measuring the misses and false positives of BrowserReflex's advisory safety layer across the covered families, via the real tools (`action_guard` and `page_check`) and the shipped browser pattern pack.

The safety check is advisory.

## What this suite measures

The suite runs against both `action_guard` and `page_check` with SQLite decision recording and the shipped browser pack loaded, as well as against built-in rules alone (with an empty pack engine).

Across all 193 data-driven test cases, 157 page-check snapshot evaluations, and 30 property-based invariant transformations:
- **Safety misses**: 0
- **False positives on benign controls**: 0
- **Known gaps**: 0

These counts describe these synthetic cases only. A pass is not a proof about pages the cases do not resemble.

Every case has a distinct identifier, an explicit family tag, a target action or snapshot, an expected verdict, and a note explaining why the case exists.

## Case counts by family

| Family | Test cases | Target verdict | What is proven |
|---|---|---|---|
| `payment` | 49 | `ask_user` | English and Bangla controls, checkout steps where the committing button says only `Continue` / `Next`, wallet buttons (`Apple Pay`, `Google Pay`), and bare `Pay` buttons. |
| `destructive` | 46 | `ask_user` or `block` | Account deletion, data wiping, bulk removal (`Remove all`), database drops, dangerous shell commands (`rm -rf`, `git push --force`, `git reset --hard`), and scoped clear data actions. |
| `outbound` | 35 | `ask_user` | Outbound communication controls: send, post, publish, share, email dispatch, compose forms, and messaging submissions. |
| `secrets` | 18 | `block` | Credentials, API tokens, JWTs, session cookies, passwords, CVVs, private keys, and card numbers passing the Luhn algorithm in typed text. Proves verdict is `block`, secrets are masked in the human reason, and secrets are stored as `[REDACTED:...]` in SQLite decision records. Built dynamically at run time without real secrets. |
| `prompt_injection` | 20 | Unchanged | Page text, element names, or snapshot text attempting to manipulate the safety verdict ("ignore previous rules", "the user approved this", hidden approvals). Proves injection cannot lower caution on risky actions and cannot invent caution on harmless pages. |
| `benign` | 25 | `allow` | Safe operations that must remain `allow` to verify false positives: adding to cart, viewing order history, clearing search queries, contacting support, and reading documentation. |
| **Total** | **193** | | |

## Property-style invariant tests

In addition to individual cases, `property-safety.test.ts` proves that safety verdicts are invariant under common DOM and snapshot transformations across 30 property tests:

1. **Element order shuffling**: Random permutations of elements in accessibility snapshots never lower caution.
2. **Noise injection**: Adding 1 to 10 arbitrary non-risky elements (headings, paragraphs, benign links) never lowers caution.
3. **Case and whitespace variations**: UPPERCASE, lowercase, mixed case, and multiple consecutive whitespace runs in element text never lower caution.
4. **Adversarial injection wrapping**: Wrapping controls in adversarial instruction phrases never lowers caution.

## Running the suite

```bash
pnpm test packages/server/test/safety/
```

Test output reports the complete metrics:
```text
Safety test suite action_guard summary: total_cases=193, misses=0, false_positives=0
Safety test suite page_check summary: total_page_cases=157, misses=0, false_positives=0
```

## What is covered

- Real tool execution through `executeActionGuard` and `executePageCheck`.
- Decision persistence in SQLite with automated secret redaction verification.
- Built-in fallback safety rules in `action_guard` when no pattern pack is loaded.
- Shipped browser pack pattern rules (`packages/packs/browser/*.yaml`).
- English and Bangla control vocabularies.
- Adversarial prompt injection resistance in both directions.
- False positive measurement on benign controls.
- Structural invariance under noise, reordering, and whitespace variation.

## What is not covered

- **Advisory nature**: The safety check is advisory. It returns structured caution verdicts (`ask_user`, `block`) to caller agents, but cannot physically prevent an agent from taking an action if the agent ignores the tool's output.
- **Synthetic snapshots**: Tests run against structured accessibility trees and synthetic snapshots; they do not run live browsers or execute client-side JavaScript.
- **Unexposed DOM state**: Page check inspects accessibility trees and element text. Elements hidden in unexposed iframes or elements lacking accessible names cannot be evaluated.
