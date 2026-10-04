# BrowserReflex: pack authoring guide

Pattern packs extend BrowserReflex with typed, versioned rules. A pack is one or more YAML files; each file contains a manifest and a list of rules. The loader validates them against the JSON schema in `packages/packs/schema.json` and reports exact line numbers for every error.

Status: **implemented and tested**. The pack loader, the pattern engine, the fixture suite, and the shipped browser pack are all implemented and tested.

> **The safety check is advisory.** A rule marked `safety: true` asks the caller to confirm with the user; nothing in a pack prevents an agent from acting. Real enforcement belongs in the agent host's own permission or hook system.

---

## YAML shape

A pack file must pass schema validation against `packages/packs/schema.json`. Required top-level keys are `id`, `name`, `version`, and `rules`. All other fields are optional.

```yaml
id: my-site-pack          # lowercase alphanumeric, hyphens, underscores
name: My Site Pack
version: 1.0.0
description: >-
  One sentence about what this pack recognises.
source: community         # builtin | community
rules:
  - id: my-site-pack.cookie.accept_all
    name: Accept all cookies control
    description: >-
      A button that accepts all cookies on this site.
    safety: false
    matchers:
      target_question_id: browser.check.popup_kind
      role:
        - button
      text_regex: '\baccept all\b'
    output:
      type: choice
      value: cookie_banner
      confidence: 0.9
      distribution:
        none: 0.05
        cookie_banner: 0.9
        promo: 0.05
```

### Manifest fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Unique pack identifier. Pattern: `^[a-z0-9_-]+$`. |
| `name` | `string` | Yes | Human-readable name. |
| `version` | `string` | Yes | Semantic version (`major.minor.patch` or compatible). |
| `description` | `string` | No | Summary of the pack's purpose. |
| `source` | `"builtin" \| "community"` | No | Origin; defaults to `"builtin"` if omitted. |
| `signature` | `string \| object \| null` | No | Placeholder field. All packs are reported as `unsigned`; verified signatures are **planned**. |

### Rule fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Unique rule identifier within this pack. |
| `name` | `string` | No | Human-readable description. |
| `description` | `string` | No | Explanation of the match condition. |
| `safety` | `boolean` | No | Advisory safety flag (see [Safety flag](#safety-flag)). |
| `confidence` | `number` | No | Top-level confidence shorthand (0.0–1.0). Overridden by `output.confidence` when present. |
| `specificity` | `number` | No | Explicit specificity score override (see [Specificity and precedence](#specificity-and-precedence)). |
| `matchers` | `object` | Yes | Match conditions. At least one matcher key is required. |
| `output` | `object` | Yes | Typed answer when the rule fires. |

---

## Matchers

The `matchers` object contains the conditions that must **all** match for the rule to fire. At least one matcher key must be present.

| Matcher | Type | Description |
|---|---|---|
| `text_any` | `string \| string[]` | Case-insensitive substring search across element text or page text. |
| `text_regex` | `string` | Regular expression matched against element text. |
| `role` | `string \| string[]` | Accessibility role(s) to match (e.g. `button`, `link`, `dialog`). |
| `url_domain` | `string \| string[]` | Domain or hostname pattern(s) to match. |
| `url_path` | `string \| string[]` | URL path pattern(s) or glob (e.g. `/checkout`, `/checkout/*`). |
| `file_path_glob` | `string \| string[]` | File path glob pattern(s). |
| `exit_code` | `integer \| integer[]` | Process exit code(s). |
| `log_regex` | `string` | Regular expression matched against log excerpts. |
| `target_question_id` | `string` | Canonical question ID this rule answers. Scopes the rule to one question only. |
| `question_id` | `string` | Alias for `target_question_id`. |

Use `target_question_id` in every rule that answers a named question. A rule that omits it can fire for any question in the same check family, which produces unexpected answers when two questions share the same signal.

---

## Output fields

| Field | Type | Required | Description |
|---|---|---|---|
| `value` | `string \| number \| boolean` | Yes | Typed answer: a choice option ID, a score number, or `true`/`false`. |
| `confidence` | `number` | Yes | Confidence score (0.0–1.0). |
| `type` | `"choice" \| "score" \| "check"` | No | Decision type. |
| `distribution` | `object` | No | Probability map across choice options (each 0.0–1.0). Provide this for `choice` answers so the engine can validate the answer against the caller's option list. |

---

## Safety flag

Mark a rule `safety: true` when the action it matches carries meaningful risk and the caller should always confirm with the user before acting. The engine reads the safety flag and applies it to precedence ordering and to the logged `is_safety` field.

**What the safety flag does:**
- Safety rules take precedence over non-safety rules when both match the same question (see [Specificity and precedence](#specificity-and-precedence)).
- The recorded decision row carries `is_safety: true`.
- The tool output carries `safety_check: "advisory"`.

**What the safety flag does not do:**
- It does not prevent an agent from acting. The verdict is a recommendation for the user, not a block.
- A learned or promoted pattern **may never carry the safety flag**. The loader enforces this: `safety` and `is_safety` are forced to `false` on all learned patterns regardless of what the stored rule says.
- An agent cannot pass a parameter (`trusted`, `user_approved`, `override`) to force an `allow` on a safety rule. Only `action`, `target`, `text`, `value`, `url`, and `snapshot` are read; any other field in the tool call is ignored.

---

## Specificity and precedence

When more than one rule matches, the engine picks the winner using three ordered criteria:

1. **Safety first.** A rule with `safety: true` always beats a rule with `safety: false`, regardless of specificity.
2. **Specificity.** Among rules at the same safety level, the more specific rule wins. Specificity is computed from the matchers present:

   | Matcher | Points |
   |---|---|
   | `url_domain` | 10 |
   | `url_path` | 10 |
   | `role` | 10 |
   | `text_any` | 10 + up to 5 for term length |
   | `text_regex` | 15 |
   | `file_path_glob` | 10 |
   | `exit_code` | 10 |
   | `log_regex` | 15 |
   | `target_question_id` / `question_id` | 5 |

   A rule with both `role` and `text_regex` scores at least 25. A rule with `url_path`, `role`, and `text_regex` scores at least 35. Compound rules naturally rank above single-signal rules.

3. **Tie-break.** When safety and specificity are equal, the rule with the lexicographically smaller `id` wins. The tie-break is deterministic and does not depend on load order.

An explicit `specificity` field on the rule overrides the computed score.

---

## Fixtures and the fixture suite

Fixtures live in `packages/packs/browser/fixtures/`. They are the test cases that prove the pack is internally consistent. The fixture test (`packages/server/test/browser-pack.test.ts`) loads the pack through the loader, runs every fixture through the engine, and requires:

- At least 95% of all fixtures pass.
- Every payment fixture passes (0 misses allowed).
- Every destructive fixture passes (0 misses allowed).

### Fixture format

```yaml
synthetic: true
provenance: Synthetic example written to resemble a real accessibility tree; not a capture of any real site.
check: payment              # cookie_banner | newsletter_popup | login_wall | captcha | payment | destructive | outbound
note: >-                   # optional: why this expectation is what it is
  The button text is only "Place order" — the most direct payment signal.
expected:
  value: ask_user           # the value the matching rule must answer
  pattern_id: browser.risky.payment.place_order   # optional: which rule must win
  # OR:
  no_match: true            # no rule of this check may fire
snapshot:
  url: https://shop.example/orders/review
  elements:
    - role: button
      text: Place order
```

Every fixture **must** declare `synthetic: true` and the `provenance` line. The test fails if either is absent. This is a hard invariant: no fixture may claim to be a capture of a real site.

**An expectation describes the outcome for one check.** A snapshot can answer more than one check, and that is fine. The fixture's `check` field identifies which check the expectation applies to.

**`no_match: true` means no rule fires**, not that the answer is `false`. When no rule matches, the decision falls to the slow path.

### Known gaps

Mark a fixture `known_gap: true` when the expected outcome is a miss that the current rules cannot cover. Known gaps are counted but not required to pass.

```yaml
known_gap: true
note: >-
  A newsletter modal with only an email input field, no subscribe button — the
  element matcher cannot see the input type, so no rule fires.
expected:
  no_match: true
```

---

## How to add a rule and test it

### 1. Add the rule to a pack YAML

Open the relevant pack file (e.g. `packages/packs/browser/cookie-banner.yaml`) or create a new pack file following the [YAML shape](#yaml-shape).

Write the new rule with:
- A stable, namespaced `id` (e.g. `browser.popup.cookie.my_new_signal`).
- A `target_question_id` matching the canonical question you are answering.
- The correct `role`, `text_regex`, or other matcher(s) for the signal.
- An `output` with `value`, `confidence`, and `distribution` if the question is a `choice`.

### 2. Write a fixture

Create a YAML fixture in `packages/packs/browser/fixtures/` (or a new directory for a custom pack). Include:
- `synthetic: true`
- `provenance: Synthetic example written to resemble a real accessibility tree; not a capture of any real site.`
- A `snapshot` whose elements trigger the new rule.
- An `expected.pattern_id` naming the new rule, so the test catches regressions.

Write a second fixture whose snapshot must **not** trigger the rule, with `expected.no_match: true` or a different expected value. This tests that you have not over-broadened the matcher.

### 3. Run the fixture suite

```bash
pnpm test
```

All tests must pass. The fixture runner will report which fixtures failed and which rule they expected.

### 4. Prove the fixture with sabotage

Temporarily remove the new rule from the pack file. Run `pnpm test`. The fixture that expects your rule's `pattern_id` must fail. Restore the rule and run `pnpm test` again; all tests must pass.

This step proves the test actually exercises the code path. A fixture that passes when the rule is absent is either:
- testing a second independent rule that also fires, or
- not reaching the code it is supposed to test.

Investigate and fix either condition before committing.

---

## Loading packs at runtime

The server loads the shipped browser pack at startup. A pack that fails to load is skipped and its errors are reported in `packs.errors` on every tool response. The server still starts and serves the rules that did load.

To load a custom pack, pass its file path in `BROWSERREFLEX_PACK_DIR` (planned) or configure the pack path in the server settings. Custom pack loading is **planned**; in the current build, only the browser pack is loaded automatically.

A pack is always reported as `unsigned`. Verified signatures are **planned**.

---

## Shipped browser pack

The browser pack (`packages/packs/browser/`) contains 33 rules across seven checks:

| Pack file | Check | Safety | Rules |
|---|---|---|---|
| `cookie-banner.yaml` | Cookie consent banner | No | 5 |
| `newsletter-popup.yaml` | Newsletter or promo popup | No | 3 |
| `login-wall.yaml` | Login wall | No | 4 |
| `captcha.yaml` | Captcha widget | No | 3 |
| `payment.yaml` | Payment action | **Yes** | 7 |
| `destructive.yaml` | Destructive action | **Yes** | 6 |
| `outbound.yaml` | Outbound send/post/publish | **Yes** | 5 |

Each pack file carries English and Bangla control text.

Accuracy on the 67 synthetic fixtures: ≥ 95% overall, 100% on payment and destructive. **Accuracy on real pages is unverified**: the fixtures are hand-written synthetic examples and are not captures of real sites.

Known limits of the browser rules are documented in [`packages/packs/browser/README.md`](../packages/packs/browser/README.md).
