# Browser pack fixtures

67 fixture files, each one synthetic.

**Every fixture in this directory is a synthetic example written to resemble a real accessibility tree. None of them is a capture of a real site, and no fixture was recorded from a live page.** Each file states this itself, and `packages/server/test/browser-pack.test.ts` fails if a file drops the statement, the `synthetic: true` flag, or the `provenance` line.

A test on synthetic fixtures written alongside the rules measures whether the pack is internally consistent. It is not a measurement of real-world accuracy: real pages were never captured, so the accuracy on real sites is **unverified**.

## Format

```yaml
synthetic: true
provenance: Synthetic example written to resemble a real accessibility tree; not a capture of any real site.
check: payment                  # cookie_banner | newsletter_popup | login_wall | captcha | payment | destructive | outbound
known_gap: true                 # optional: a gap these rules are known to miss
note: >-                        # optional: why the expectation is what it is
  A short sentence for the reader.
expected:
  value: ask_user               # the value the matching rule must answer
  pattern_id: browser.risky.payment.place_order   # optional: the exact winning rule
  # or, instead of `value`:
  no_match: true                # no rule of this check may fire
snapshot:
  url: https://shop.example/orders/review
  elements:
    - role: button
      text: Place order
```

`snapshot` is the engine's snapshot shape. For an element, `role` is the accessibility role and `text` is the accessible name a person reads, which for an input field is its label or placeholder. `url` is the page URL. Example domains (`shop.example`, `mail.example`) are used throughout.

## What an expectation means

- `expected.value` names the value the winning rule must answer for the question of the fixture's `check`, and the winning rule must always be a rule of that check.
- `expected.pattern_id`, when present, names the exact rule that must win.
- `expected.no_match: true` means no rule of that check fires, which is not the same as an answer of `false`: the fast path has nothing to say and the decision goes to the slow path.
- An expectation always describes the outcome for the fixture's own `check`. One snapshot can answer more than one check, and `login-benign-guest-checkout.yaml` is the example: no login wall, but a real payment signal on the same page.

## Coverage

| Check | Fixtures | Of which expect no match |
|---|---|---|
| `cookie_banner` | 7 | 1 |
| `newsletter_popup` | 8 | 2, one of them a recorded known gap |
| `login_wall` | 8 | 2 |
| `captcha` | 7 | 2 |
| `payment` | 14 | 2 |
| `destructive` | 14 | 4 |
| `outbound` | 9 | 2 |

Benign pages that must not trigger a risky rule are included on purpose: an order history link, an article about deleting browser caches, restoring deleted items, removing applied filters, an article about sending email, downloading an invoice, adding to a cart or a wishlist.

Tricky cases are included on purpose: a payment verb inside a longer button label, a destructive verb inside a confirm button, a Bangla control on each risky family, a `Restore deleted items` button that must not read as a delete, and a heading about captchas that must not read as a widget.