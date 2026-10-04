# Browser pattern pack v1

Versioned YAML rules for the seven browser checks in the specification, plus the synthetic fixtures they are measured on.

Status: **implemented and tested** for the rules, the pack loader path and the fixture suite (`packages/server/test/browser-pack.test.ts`). **Planned:** the `page_check` and `action_guard` tools that would serve these rules do not exist yet, so the canonical question shapes live in the test rather than in a served tool.

The safety check is **advisory**. A rule marked `safety: true` tells the caller to ask the user; nothing in this pack prevents an agent from acting, and an agent that never calls BrowserReflex is not stopped by it.

## Checks and rules

| Pack file | Check | Rule id prefix | Decision type | Rule count |
|---|---|---|---|---|
| `cookie-banner.yaml` | Cookie banner | `browser.popup.cookie.` | choice `cookie_banner` | 5 |
| `newsletter-popup.yaml` | Newsletter or promo popup | `browser.popup.promo.` | choice `promo` | 3 |
| `login-wall.yaml` | Login wall | `browser.login_wall.` | check `true` | 4 |
| `captcha.yaml` | Captcha | `browser.captcha.` | check `true` | 3 |
| `payment.yaml` | Payment action | `browser.risky.payment.` | choice `ask_user`, `safety: true` | 7 |
| `destructive.yaml` | Destructive action | `browser.risky.destructive.` | choice `ask_user`, `safety: true` | 6 |
| `outbound.yaml` | Send, post or publish | `browser.risky.outbound.` | choice `ask_user`, `safety: true` | 5 |

Every rule also carries Bangla control text: `অর্ডার করুন`, `কিনুন`, `পেমেন্ট`, `চেকআউট`, `সম্মতি দিন`, `কুকি`, `পাঠান`, `প্রকাশ করুন`, `সাবস্ক্রাইব`, `মুছুন`, `অ্যাকাউন্ট মুছুন`, `লগ ইন করুন`, `আমি রোবট নই`.

## Canonical questions

Each rule declares `target_question_id`, so a rule answers one question and never another. A caller that asks the same question under a different id gets no fast answer for that family; the decision falls to the slow path rather than being answered by a neighbouring rule.

| Question id | Type | Options or value |
|---|---|---|
| `browser.check.popup_kind` | choice | `none`, `cookie_banner`, `promo` |
| `browser.check.login_wall` | check | `true` when a gate looks like it is in the way |
| `browser.check.captcha` | check | `true` when a human verification widget is shown |
| `browser.check.risky_action` | choice | `allow`, `ask_user`, `block`; this pack only ever answers `ask_user` |

The choice rules carry a `distribution` over the option ids above, because the engine validates a choice answer against the question it was asked. A caller whose options differ from this table gets no fast answer for that family.

## Known limits of these rules

- **A rule matches one element at a time.** It cannot require an email field and a close control together, so a newsletter modal that offers nothing but an email input is not detected (`fixtures/promo-known-gap-email-only-modal.yaml` records this as a known gap).
- **A password field is matched through its accessible name.** The engine has no matcher for an input's type or attributes, so `input_type: password` cannot be read. A sign up form also carries a password field and reads as `login_wall: true`.
- **A captcha served from an unnamed frame is not detected.** There is no matcher for an iframe's source URL, so detection rests on the accessible text the widget exposes.
- **Text inside a sentence is matched.** `Review and place your order` is a payment action and `Yes, delete my account` is a destructive one, by design.
- **Help text that reads like a control is a false positive.** A link whose text is `Delete account` fires the destructive rule wherever it appears, including inside a help article.
- **Word boundaries are ASCII.** `\b` does not fire inside Bangla text, so Bangla alternatives are written without it.
- **One snapshot can answer several checks.** A cart page with a `Checkout` button answers the login wall check with no fast answer and the risky action check with `ask_user`. The pack does not arbitrate between check questions; that is the caller's job.

## Fixtures

65 synthetic fixtures live in `fixtures/`; see [fixtures/README.md](fixtures/README.md). They are hand written to resemble real accessibility trees. None of them is a capture of a real site.