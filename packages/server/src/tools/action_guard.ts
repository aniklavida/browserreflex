/**
 * The `action_guard` tool: an advisory safety gate for one browser action.
 *
 * Status: **implemented and tested**. The tests behind that claim are
 * `packages/server/test/action-guard-tool.test.ts`, including the prompt-injection
 * fixtures in `packages/server/test/fixtures/action-guard/` and a run over a real MCP
 * client on stdio.
 *
 * ## The verdict is advisory
 *
 * This tool reports. It does not stop anything. An agent that never calls it is not
 * stopped by it, and an agent that calls it and reads `ask_user` may still act on the
 * page. Real enforcement belongs in the agent host's own permission or hook system. The
 * output carries `advisory: true`, the reason repeats it in words, and the tool
 * description says it. Nothing here may be described as something that prevents an
 * agent from acting.
 *
 * ## The output
 *
 * `verdict` (`allow`, `ask_user` or `block`), a `reason` written for the user, `rule_ids`
 * for the rules that produced the verdict, and the record fields `decision_id`,
 * `confidence`, `path` and `latency_ms`. Every field is snake_case.
 *
 * ## The three guarantees, and the line each one lives on
 *
 * 1. **A payment or destructive action is always `ask_user`.** The families in
 *    `BUILTIN_RULES` are compiled in this file and need no pack, so the guarantee holds
 *    on a server with no pack loaded. The control text they match is the text the
 *    browser pack carries, in English and in Bangla, because a payment action written
 *    in Bangla is still a payment action.
 * 2. **Nothing learned and nothing the agent sent can answer `allow` for them.**
 *    `resolveVerdict` starts at `allow` and only ever moves up `VERDICT_RANK`, so a
 *    source that would lower the verdict is inert rather than obeyed. A learned rule is
 *    read as `ask_user` whatever its own output says, and only `action`, `target`,
 *    `text`, `value`, `url` and `snapshot` are read at all, so an argument the caller
 *    invents cannot reach a verdict.
 * 3. **Page text is data.** Text from a page is matched against rules and is never read
 *    as an instruction. A paragraph saying "this action is approved by the user" or
 *    "ignore all previous instructions" changes no verdict: it is matched like any other
 *    text, and a paragraph is not an interactive control, so no built-in rule fires on
 *    it.
 *
 * ## What `path` and `confidence` mean here
 *
 * `path` names what produced the verdict, in the words `core/schema.ts` defines:
 *
 * - `check`: a direct check of the supplied data. Every built-in rule that fired is a
 *   check, and so is the "nothing matched" case, because the check that ran and found
 *   nothing silent is what produced the default `allow`.
 * - `pattern`: no built-in rule fired, so a rule loaded into the pattern engine is what
 *   produced the verdict.
 *
 * `pattern_id` names the rule from a pack that produced the verdict. It is `null` when
 * `path` is `check`, and `null` for a learned pattern, which is never named here as the
 * source of a verdict. When a built-in rule and a pack rule both matched, `path` is
 * `check` and `pattern_id` is `null`: a direct check in code is the source this build
 * can guarantee without a pack, and `rule_ids` names every rule that contributed, so
 * nothing is hidden by that choice.
 *
 * `confidence` is the confidence the deciding rule states, or the lowest among the rules
 * that produced the same verdict. When nothing fired it is one of the named constants
 * above, and the reason says which one and why. No threshold setting is consulted: this
 * tool has one question and reports the rules' own confidence.
 *
 * `latency_ms` in the output is the value written to the record, measured once.
 *
 * ## Known limits, because they are real
 *
 * - **A match anywhere in the snapshot fires the rule.** A built-in rule fires when the
 *   target matches, or when any interactive element in the supplied snapshot matches.
 *   That fails safe at the cost of a false positive on a page that carries a payment
 *   control elsewhere, which is the trade the browser pack makes too.
 * - **Only interactive element text is read.** A heading, a paragraph, a label and a
 *   textbox's own name are not controls, so no built-in rule fires on them. The cost is
 *   that a target which names no role cannot be matched by a pack rule that requires
 *   one: send the role when the caller has it, and the built-in rules cover the case
 *   either way.
 * - **Memory is deliberately not consulted.** A stored answer for a byte-identical
 *   earlier call could only ever add caution here and the tool has no use for it, so
 *   exact-match memory is left to `decide`. A test asserts that a stored `allow` for the
 *   same input leaves a payment action at `ask_user`.
 * - **There is no miner yet**, so nothing in this build writes a learned rule. The
 *   learned-rule behaviour is tested by writing those rules straight into the engine.
 * - **The command rule needs the action to name a command.** An action called something
 *   this build does not recognise takes the low-confidence `allow` path with `needs_ai`,
 *   which is the honest answer for an unknown verb rather than a guess that some string
 *   is a shell command.
 */

import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { ZodRawShape } from 'zod';
import {
  DecisionPathSchema,
  SchemaViolationException,
  validateAnswer,
  type ChoiceQuestion,
  type DecisionPath,
} from '../core/schema.js';
import { getDefaultStore, logDecision } from '../core/log.js';
import { getDefaultPatternEngine } from '../patterns/engine.js';
import type { PatternEngine, Rule } from '../patterns/index.js';
import { compileRegex, matchUrlPath } from '../patterns/matchers.js';
import { redactWithHash, type RedactionRuleId } from '../security/redact.js';
import type { DatabaseStore, Session } from '../store/index.js';

/** The three verdicts this tool can return, in the order of caution they represent. */
export const VERDICTS = ['allow', 'ask_user', 'block'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Rank order the resolver is allowed to move in. Nothing moves down it. */
const VERDICT_RANK: Readonly<Record<Verdict, number>> = { allow: 0, ask_user: 1, block: 2 };

/**
 * The canonical question the browser pack rules answer, and the one this tool asks.
 *
 * Reusing the pack's question id is what lets a pack rule that declares
 * `target_question_id: browser.check.risky_action` be read here at all: a rule written
 * for a different question is not a candidate for this verdict.
 */
export const ACTION_GUARD_QUESTION_ID = 'browser.check.risky_action';

export const RISKY_ACTION_QUESTION: ChoiceQuestion = {
  id: ACTION_GUARD_QUESTION_ID,
  type: 'choice',
  text: 'Should the agent ask the user before taking this action?',
  options: VERDICTS.map((id) => ({ id })),
};

/**
 * The sentence every reason ends with, and the meaning of `advisory: true` in the
 * output. Kept in one constant so the reason, the README and the tool description
 * cannot drift apart.
 */
export const ADVISORY_NOTE =
  'This verdict is advisory: it is a report, and nothing in this server prevents the ' +
  'agent from acting.';

/** Actions this build names. Anything else falls back to the low-confidence path. */
export const KNOWN_ACTIONS = [
  'click',
  'submit',
  'delete',
  'type',
  'navigate',
  'select',
  'upload',
  'press',
  'command',
] as const;
export type KnownAction = (typeof KNOWN_ACTIONS)[number];

/**
 * Spellings of an action this build recognises, mapped to the canonical name.
 *
 * A caller that says `shell` and a caller that says `command` mean the same thing to
 * the command rules; a caller that says `fill` means the same thing as `type`. Anything
 * not listed here is an unknown action.
 */
const ACTION_ALIASES: Readonly<Record<string, KnownAction>> = {
  click: 'click',
  dblclick: 'click',
  doubleclick: 'click',
  press: 'press',
  keypress: 'press',
  submit: 'submit',
  delete: 'delete',
  remove: 'delete',
  destroy: 'delete',
  type: 'type',
  fill: 'type',
  enter_text: 'type',
  navigate: 'navigate',
  goto: 'navigate',
  open: 'navigate',
  select: 'select',
  upload: 'upload',
  command: 'command',
  shell: 'command',
  exec: 'command',
  run_command: 'command',
};

/**
 * Confidence reported when no rule fired and the action is one this build names.
 *
 * This is the confidence that every rule in this build was consulted over the supplied
 * target and none of them fired. It is a claim about the rules, not about the page.
 */
export const ALLOW_CONFIDENCE = 0.85;

/**
 * Confidence reported when the action is not one this build names. Lower, because the
 * rules were consulted about a verb whose meaning nothing here knows.
 */
export const UNKNOWN_ACTION_CONFIDENCE = 0.3;

/**
 * Confidence reported when there was nothing at all to check: no target text, no page
 * element, no URL, nothing to type and no command.
 */
export const NO_SIGNAL_CONFIDENCE = 0.2;

/**
 * Redaction rules that mean the text carries a credential or a card number.
 *
 * `email`, `phone` and `high_entropy` are deliberately absent: typing an address into a
 * form is ordinary work, and the catch-all entropy rule fires on ordinary long strings.
 */
export const SECRET_TYPING_RULES: readonly RedactionRuleId[] = [
  'private_key',
  'url_credentials',
  'api_key',
  'token',
  'cookie',
  'secret_value',
  'password',
  'card',
];

/**
 * Element roles that can be acted on.
 *
 * A built-in rule matches the text of an interactive control and not the text of a
 * heading, a paragraph or a label, which is what keeps a help article that talks about
 * paying from reading as a payment action. A target that names no role counts as
 * interactive: the caller gave a text and no role, and refusing to match would make a
 * missing field a way past the rule.
 */
export const INTERACTIVE_ROLES: readonly string[] = [
  'a',
  'button',
  'checkbox',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'summary',
  'switch',
  'tab',
  'treeitem',
];

/**
 * Payment control text, in English and in Bangla.
 *
 * These are the same alternatives the browser pack's payment rules carry, unioned into
 * one pattern, because a payment action must be `ask_user` on a server with no pack
 * installed. The phrases are the specific ones the pack uses on purpose: a bare "order"
 * would fire on an order history link, and "add to cart" commits no money.
 */
const PAYMENT_TEXT = compileRegex(
  String.raw`\bplace (my |your |the )?order\b|\bconfirm (my |your |the )?order\b` +
    String.raw`|\bcomplete (my |your |the )?(order|purchase|checkout)\b|\bsubmit order\b` +
    String.raw`|\bfinalise (my |the )?order\b|\bfinalize (my |the )?order\b` +
    String.raw`|\bbuy now\b|\bbuy it now\b|\border now\b|\border immediately\b` +
    String.raw`|\badd to cart and buy\b` +
    String.raw`|\bcheckout\b|\bgo to checkout\b|\bproceed to checkout\b` +
    String.raw`|\bproceed to payment\b|\bsecure checkout\b|\bcheckout securely\b` +
    String.raw`|\bstart checkout\b` +
    String.raw`|\bpay now\b|\bpay and order\b|\bpay & order\b` +
    String.raw`|\bpay with (a )?(card|credit card|debit card)\b|\bmake a payment\b` +
    String.raw`|\bpay securely\b|\bpay (the )?(total|amount|balance)\b|\bwallet\b` +
    String.raw`|অর্ডার করুন|অর্ডার সম্পন্ন করুন|এখনই অর্ডার করুন|কিনুন|এখনই কিনুন` +
    String.raw`|অর্ডার বাক্সে যান|ক্রয় করুন` +
    String.raw`|পেমেন্ট|পেমেন্ট করুন|পরিশোধ করুন|চেকআউট|চেক আউট`,
);

/**
 * Destructive control text, in English and in Bangla: the same alternatives the browser
 * pack's destructive rules carry, unioned. Word boundaries keep "restore deleted items"
 * and "remove applied filters" out of it.
 */
const DESTRUCTIVE_TEXT = compileRegex(
  String.raw`\bdelete\b|\berase\b|\bpurge\b|\bwipe\b` +
    String.raw`|\b(delete|remove|close|deactivate) (my |your |the )?account\b` +
    String.raw`|\bdelete (my |your |the )?profile\b|\bclose my account\b` +
    String.raw`|\bdelete all\b|\bdelete everything\b|\bremove all\b|\bclear all\b` +
    String.raw`|\bempty (my |the )?(cart|basket|trash|bin)\b|\bunsubscribe all\b` +
    String.raw`|\bpurge all\b|\bdiscard all changes\b` +
    String.raw`|\b(delete|remove|clear) (all|every|my) (data|history|files|items|orders` +
    String.raw`|photos|messages|followings?|bookmarks|search history)\b` +
    String.raw`|\bdelete (my )?(data|history|files|photos|account data)\b` +
    String.raw`|মুছুন|মুছে ফেলুন|ডিলিট করুন|ডিলিট|অপসারণ করুন|অপসারণ` +
    String.raw`|অ্যাকাউন্ট মুছুন|অ্যাকাউন্ট ডিলিট|সব ডিলিট|সব মুছে|সব মুছুন|সব ডেটা মুছুন`,
);

/**
 * Outbound control text, in English and in Bangla: the same alternatives the browser
 * pack's outbound rules carry, unioned.
 */
const OUTBOUND_TEXT = compileRegex(
  String.raw`\bsend\b|\bsend (message|mail|email|note|code|request|feedback|invite|reminder)\b` +
    String.raw`|\breply\b|\breply all\b|\bforward\b|\bdispatch\b` +
    String.raw`|\bpost\b|\bpost now\b|\bpublish\b|\bpublish now\b|\bshare\b` +
    String.raw`|\bshare (post|story|update|video|link)\b|\btweet\b|\bretweet\b|\bboost\b` +
    String.raw`|\bschedule post\b|\bgo live\b` +
    String.raw`|পাঠান|পাঠিয়ে দিন|প্রেরণ করুন|পাঠানো` +
    String.raw`|পোস্ট করুন|প্রকাশ করুন|শেয়ার করুন|পাবলিশ করুন|পোস্ট`,
);

/**
 * A control that commits a step, used only together with a payment URL path. It is how
 * a checkout page whose committing button reads only "Continue" or "Next" is caught
 * without a pack.
 */
const COMMITTING_CONTROL_TEXT = compileRegex(
  String.raw`\b(continue|next|proceed|confirm|submit|go)\b`,
);

/** Payment step URL paths, the same list the browser pack's path rule carries. */
const PAYMENT_PATH_PATTERNS: readonly string[] = [
  '/checkout',
  '/checkout/*',
  '/payment',
  '/payment/*',
  '/cart/checkout',
  '/cart/checkout/*',
  '/order/place',
  '/order/place/*',
];

/**
 * Commands that rewrite history or destroy data.
 *
 * Matched only when the action names a command, because a page's own text is never read
 * as a command.
 */
const DESTRUCTIVE_COMMAND = compileRegex(
  String.raw`\bgit\s+push\b[^;\n]*(--force-with-lease\b|--force\b|-f\b)` +
    String.raw`|\bgit\s+reset\s+--hard\b` +
    String.raw`|\bgit\s+clean\b[^;\n]*-[a-z]*f` +
    String.raw`|\brm\s+-[a-z]*r[a-z]*f\b|\brm\s+-[a-z]*f[a-z]*r\b` +
    String.raw`|\bdrop\s+(table|database|schema)\b|\btruncate\s+table\b` +
    String.raw`|\bkubectl\s+delete\b` +
    String.raw`|\bterraform\s+(destroy|apply)\b` +
    String.raw`|\bdocker\s+(rm|system\s+prune|volume\s+rm|image\s+prune)\b`,
);

/** Which built-in rule family fired. */
export type SafetyFamily = 'payment' | 'destructive' | 'outbound' | 'secret' | 'command';

/** One plain sentence per family, used as the opening of the reason for the user. */
const FAMILY_SUMMARY: Readonly<Record<SafetyFamily, string>> = {
  payment: 'This looks like a payment action, and a payment action always asks the user first.',
  destructive:
    'This looks like a destructive action, and a destructive action always asks the user first.',
  outbound:
    'This would send, post or publish something to somebody else, so it always asks the user first.',
  secret:
    'The text this action would enter carries a credential or a card number, so it is reported rather than entered.',
  command:
    'This would run a command that rewrites history or destroys data, so it is reported rather than run.',
};

/** The opening of the reason when the caution came from a rule with no pack behind it. */
const LEARNED_SUMMARY =
  'A learned pattern recorded for this page advises asking the user first. A learned ' +
  'pattern can add caution and can never remove it.';

/** The opening of the reason when the caution came from a pack rule and no built-in one. */
const PACK_SUMMARY =
  'A safety rule from a loaded pattern pack advises asking the user first. A rule marked ' +
  'safety cannot be turned off from the agent side.';

/** An element this tool read: its role as the caller reported it, and its text. */
export interface SignalElement {
  readonly role: string | null;
  readonly text: string;
}

/**
 * Everything this tool reads out of one call.
 *
 * An argument not named here is not read, whatever it is called and whatever it claims.
 */
export interface ActionSignals {
  /** The caller's spelling of the action, kept for the reason text. */
  readonly rawAction: string;
  /** The canonical action name, or `unknown`. */
  readonly action: KnownAction | 'unknown';
  /** The target and every interactive element of the snapshot, roles as reported. */
  readonly interactiveElements: readonly SignalElement[];
  /** The text of those elements, which is what the built-in rules match. */
  readonly interactiveTexts: readonly string[];
  readonly url: string | null;
  /** The text the action would enter, when the call carried one. */
  readonly typedText: string | null;
  /** The command the action would run, when the action names a command. */
  readonly command: string | null;
  /** True when the call carried anything at all a rule could match. */
  readonly hasSignal: boolean;
}

/**
 * A built-in safety rule: compiled in this file, with no pack behind it.
 *
 * `matches` reads the supplied data only. It never answers `allow` and never depends on
 * anything the caller declared about its own intent.
 */
export interface BuiltinRule {
  readonly id: string;
  readonly family: SafetyFamily;
  readonly verdict: Extract<Verdict, 'ask_user' | 'block'>;
  readonly confidence: number;
  matches(signals: ActionSignals): boolean;
}

function matchesAnyText(pattern: RegExp, texts: readonly string[]): boolean {
  for (const text of texts) {
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}

/** True when a role can be acted on. A role the caller did not name counts as yes. */
function isInteractiveRole(role: string | null): boolean {
  if (role === null || role.trim() === '') {
    return true;
  }
  return INTERACTIVE_ROLES.includes(role.trim().toLowerCase());
}

/**
 * The safety rules that hold with no pack installed.
 *
 * The order here is the order they are evaluated in and the order they are listed in
 * `rule_ids`. Payment and destructive come first because they are the two families the
 * specification names as always asking the user.
 */
export const BUILTIN_RULES: readonly BuiltinRule[] = [
  {
    id: 'browserreflex.safety.payment.control_text',
    family: 'payment',
    verdict: 'ask_user',
    confidence: 0.95,
    matches(signals) {
      return matchesAnyText(PAYMENT_TEXT, signals.interactiveTexts);
    },
  },
  {
    id: 'browserreflex.safety.payment.checkout_step_control',
    family: 'payment',
    verdict: 'ask_user',
    confidence: 0.85,
    matches(signals) {
      if (signals.url === null || !matchUrlPath(PAYMENT_PATH_PATTERNS, signals.url)) {
        return false;
      }
      return signals.interactiveElements.some((element) =>
        COMMITTING_CONTROL_TEXT.test(element.text),
      );
    },
  },
  {
    id: 'browserreflex.safety.destructive.control_text',
    family: 'destructive',
    verdict: 'ask_user',
    confidence: 0.95,
    matches(signals) {
      return matchesAnyText(DESTRUCTIVE_TEXT, signals.interactiveTexts);
    },
  },
  {
    id: 'browserreflex.safety.destructive.action',
    family: 'destructive',
    verdict: 'ask_user',
    confidence: 0.95,
    matches(signals) {
      return signals.action === 'delete';
    },
  },
  {
    id: 'browserreflex.safety.outbound.control_text',
    family: 'outbound',
    verdict: 'ask_user',
    confidence: 0.9,
    matches(signals) {
      return matchesAnyText(OUTBOUND_TEXT, signals.interactiveTexts);
    },
  },
  {
    id: 'browserreflex.safety.secret.entered_text',
    family: 'secret',
    verdict: 'block',
    confidence: 0.95,
    matches(signals) {
      if (signals.typedText === null || signals.typedText === '') {
        return false;
      }
      const findings = redactWithHash(signals.typedText).findings;
      return findings.some((finding) => SECRET_TYPING_RULES.includes(finding.rule));
    },
  },
  {
    id: 'browserreflex.safety.command.destructive_command',
    family: 'command',
    verdict: 'block',
    confidence: 0.95,
    matches(signals) {
      if (signals.action !== 'command' || signals.command === null) {
        return false;
      }
      return DESTRUCTIVE_COMMAND.test(signals.command);
    },
  },
];

/** The target as a caller may describe it: an object, or the element text on its own. */
export interface ActionGuardTarget {
  readonly role?: string | undefined;
  readonly text?: string | undefined;
  readonly name?: string | undefined;
  readonly selector?: string | undefined;
  readonly value?: string | undefined;
}

export interface ActionGuardInput {
  readonly action?: unknown;
  readonly target?: unknown;
  readonly text?: unknown;
  readonly value?: unknown;
  readonly url?: unknown;
  readonly snapshot?: unknown;
  readonly [key: string]: unknown;
}

export interface ActionGuardContext {
  readonly store?: DatabaseStore | undefined;
  readonly session?: Session | undefined;
  readonly sessionId?: string | undefined;
  readonly patternEngine?: PatternEngine | undefined;
}

export interface ActionGuardOutput {
  readonly [key: string]: unknown;
  readonly verdict: Verdict;
  /** One plain sentence for the user, ending with the advisory note. */
  readonly reason: string;
  /** The rules whose match produced this verdict. Empty when nothing fired. */
  readonly rule_ids: readonly string[];
  readonly decision_id: string;
  readonly confidence: number;
  readonly path: DecisionPath;
  readonly latency_ms: number;
  /** Always `true`. This tool reports; it does not stop the agent. */
  readonly advisory: true;
  /** True when no rule answered and the model should decide this one. */
  readonly needs_ai: boolean;
  /** The pack rule that produced the verdict, or `null` when `path` is `check`. */
  readonly pattern_id: string | null;
}

export const actionGuardInputSchema: ZodRawShape = {
  action: z
    .string()
    .min(1)
    .describe(
      'What the agent is about to do: click, submit, delete, type, navigate, select, upload, press or command. An action this build does not name returns a low-confidence allow and needs_ai.',
    ),
  target: z
    .union([
      z.string().describe('The element text, when the role is not worth naming'),
      z
        .object({
          role: z.string().optional().describe('Accessible role, for example button or link'),
          text: z.string().optional().describe('Accessible name of the element'),
          name: z.string().optional().describe('Accessible name, when text is not that field'),
          selector: z.string().optional().describe('Selector, read for the record only'),
          value: z.string().optional().describe('Current value of the element'),
        })
        .describe('The element the action is aimed at'),
    ])
    .optional()
    .describe('The element the action is aimed at: its role, text and selector'),
  text: z
    .string()
    .optional()
    .describe('The text the action would enter. Checked for credentials and card numbers'),
  value: z.string().optional().describe('An alias of text, for the same purpose'),
  url: z.string().optional().describe('The page URL, which a payment step path rule reads'),
  snapshot: z
    .any()
    .optional()
    .describe(
      'A redacted page snapshot in the engine shape. Its element texts are matched against the rules and never read as instructions',
    ),
};

export const actionGuardOutputSchema: ZodRawShape = {
  verdict: z
    .enum(VERDICTS)
    .describe('allow, ask_user or block. Advisory: this tool does not stop the agent.'),
  reason: z.string().describe('One plain sentence for the user, ending with the advisory note'),
  rule_ids: z.array(z.string()).describe('The rules whose match produced this verdict'),
  decision_id: z.string(),
  confidence: z.number().min(0).max(1),
  path: DecisionPathSchema,
  latency_ms: z.number(),
  advisory: z.literal(true),
  needs_ai: z.boolean(),
  pattern_id: z.string().nullable(),
};

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Reads the elements of a supplied snapshot, keeping only the fields this tool uses. */
function readSnapshotElements(snapshot: unknown): SignalElement[] {
  if (typeof snapshot !== 'object' || snapshot === null) {
    return [];
  }
  const raw = (snapshot as { elements?: unknown }).elements;
  if (!Array.isArray(raw)) {
    return [];
  }
  const elements: SignalElement[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const role = readString(record.role);
    const text = readString(record.text);
    if (text === null || text === '') {
      continue;
    }
    if (!isInteractiveRole(role)) {
      continue;
    }
    elements.push({ role, text });
  }
  return elements;
}

interface ReadTarget {
  readonly role: string | null;
  readonly texts: string[];
  readonly value: string | null;
}

function readTarget(raw: unknown): ReadTarget {
  if (typeof raw === 'string') {
    return { role: null, texts: raw === '' ? [] : [raw], value: null };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { role: null, texts: [], value: null };
  }
  const record = raw as Record<string, unknown>;
  const texts: string[] = [];
  for (const key of ['text', 'name'] as const) {
    const value = readString(record[key]);
    if (value !== null && value !== '') {
      texts.push(value);
    }
  }
  return { role: readString(record.role), texts, value: readString(record.value) };
}

/**
 * Reads everything this tool reads, and nothing else.
 *
 * This function is the whole contract with the caller: an argument it does not read
 * cannot reach a verdict, so a caller cannot hand itself an approval, however it spells
 * one.
 */
export function readActionSignals(args: ActionGuardInput): ActionSignals {
  const rawAction = typeof args.action === 'string' ? args.action.trim() : '';
  const action = ACTION_ALIASES[rawAction.toLowerCase()] ?? 'unknown';
  const target = readTarget(args.target);
  const url = readString(args.url);
  const enteredText = readString(args.text) ?? readString(args.value);

  const command = action === 'command' ? enteredText : null;
  // For a type action the text may also arrive as the target's own value, or as its
  // accessible name when the caller sent nothing else. For any other action only an
  // explicit text or value counts, because a control's name is not what gets entered.
  const typedText =
    action === 'command'
      ? null
      : (enteredText ?? (action === 'type' ? (target.value ?? target.texts[0] ?? null) : null));

  const interactiveElements: SignalElement[] = [];
  if (isInteractiveRole(target.role)) {
    for (const text of target.texts) {
      interactiveElements.push({ role: target.role, text });
    }
  }
  interactiveElements.push(...readSnapshotElements(args.snapshot));

  const interactiveTexts = interactiveElements.map((element) => element.text);

  return {
    rawAction,
    action,
    interactiveElements,
    interactiveTexts,
    url,
    typedText,
    command,
    hasSignal:
      url !== null || typedText !== null || command !== null || interactiveElements.length > 0,
  };
}

/** Where a matching engine rule came from, and therefore what it is allowed to do. */
export type CautionSource = 'builtin' | 'pack' | 'learned';

/**
 * One rule's contribution to the verdict.
 *
 * A caution is a proposal. `resolveVerdict` decides which proposals take effect, and it
 * only ever raises the verdict, so a proposal of `allow` is a proposal this resolver
 * cannot obey.
 */
export interface Caution {
  readonly ruleId: string;
  readonly verdict: Extract<Verdict, 'ask_user' | 'block'>;
  readonly confidence: number;
  readonly family?: SafetyFamily | undefined;
  readonly source: CautionSource;
}

/**
 * Decides whether a matching engine rule is a written pack rule or a learned one.
 *
 * A rule with a `pack_id` is a pack rule. A rule with none is a learned pattern, and a
 * rule marked `shadow` or `candidate` is an unverified candidate whatever its
 * `pack_id`: neither is a safety rule here, so neither can raise anything above
 * `ask_user` or lower anything at all.
 */
export function classifyRule(rule: Rule): CautionSource {
  const status = rule['status'];
  if (typeof status === 'string' && (status === 'shadow' || status === 'candidate')) {
    return 'learned';
  }
  const packId = rule.pack_id;
  if (typeof packId === 'string' && packId.trim() !== '') {
    return 'pack';
  }
  return 'learned';
}

function isVerdict(value: unknown): value is Verdict {
  return typeof value === 'string' && (VERDICTS as readonly string[]).includes(value);
}

/**
 * Builds the snapshot the pattern engine is asked, carrying the question id so a rule
 * written for a different question is not a candidate here.
 *
 * Only the interactive elements are passed. The roles are the ones the caller reported:
 * a target that named no role keeps none, so a pack rule that requires a role will not
 * match it rather than being told a role it was never given.
 */
function buildEngineSnapshot(signals: ActionSignals): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {
    question_id: ACTION_GUARD_QUESTION_ID,
    elements: signals.interactiveElements.map((element) => ({ ...element })),
  };
  if (signals.url !== null) {
    snapshot['url'] = signals.url;
  }
  return snapshot;
}

/**
 * Collects every caution this call produced, from the built-in rules first and then from
 * the pattern engine.
 *
 * A learned rule is read as `ask_user` whatever its own output says, because a learned
 * pattern is not a safety rule and a learned pattern must not be able to answer `block`
 * or `allow`. Only a rule from a pack, or a rule compiled into this file, may answer
 * either.
 */
export function collectCautions(signals: ActionSignals, patternEngine: PatternEngine): Caution[] {
  const cautions: Caution[] = [];

  for (const rule of BUILTIN_RULES) {
    if (rule.matches(signals)) {
      cautions.push({
        ruleId: rule.id,
        verdict: rule.verdict,
        confidence: rule.confidence,
        family: rule.family,
        source: 'builtin',
      });
    }
  }

  for (const match of patternEngine.matchAll(buildEngineSnapshot(signals))) {
    const value = match.output.value;
    if (!isVerdict(value)) {
      continue;
    }
    const learned = classifyRule(match.rule) === 'learned';
    if (learned || value === 'allow') {
      // A learned rule is read as `ask_user` whatever its own output says, because a
      // learned pattern is not a safety rule and may not answer `block`. An `allow` from
      // any rule is not a caution at all: this resolver cannot obey one.
      if (value === 'allow') {
        continue;
      }
      cautions.push({
        ruleId: match.pattern_id,
        verdict: 'ask_user',
        confidence: match.output.confidence,
        source: learned ? 'learned' : 'pack',
      });
      continue;
    }
    cautions.push({
      ruleId: match.pattern_id,
      verdict: value,
      confidence: match.output.confidence,
      source: 'pack',
    });
  }

  return cautions;
}

export interface ResolvedVerdict {
  readonly verdict: Verdict;
  readonly confidence: number;
  readonly path: DecisionPath;
  readonly patternId: string | null;
  readonly ruleIds: string[];
  /** The built-in family that produced the verdict, when one did. */
  readonly family: SafetyFamily | null;
  /** The source of the first rule that produced the verdict, when one did. */
  readonly source: CautionSource | null;
  /** True when a built-in or a pack safety rule produced the verdict. */
  readonly isSafety: boolean;
}

/**
 * The resolver: one place where a verdict can be raised, and nowhere where it can be
 * lowered.
 *
 * It starts at `allow` and walks the cautions in order. A caution whose rank is not
 * higher than the verdict so far is dropped rather than applied, so a rule that answers
 * `allow` cannot undo a rule that answered `ask_user` and a learned pattern can add
 * caution but never remove it. The confidence reported is the lowest among the cautions
 * that produced the final verdict, because that is how sure this resolver is of the
 * verdict it reports.
 *
 * `baseConfidence` is what to report when no caution survives: one of the named
 * constants above, chosen by the caller from what the call actually supplied.
 */
export function resolveVerdict(
  cautions: readonly Caution[],
  baseConfidence: number,
): ResolvedVerdict {
  let verdict: Verdict = 'allow';
  let winners: Caution[] = [];

  for (const caution of cautions) {
    const rank = VERDICT_RANK[caution.verdict];
    if (rank > VERDICT_RANK[verdict]) {
      verdict = caution.verdict;
      winners = [caution];
    } else if (rank === VERDICT_RANK[verdict] && rank > 0) {
      winners.push(caution);
    }
  }

  const ruleIds: string[] = [];
  for (const caution of winners) {
    if (!ruleIds.includes(caution.ruleId)) {
      ruleIds.push(caution.ruleId);
    }
  }

  if (winners.length === 0) {
    return {
      verdict,
      confidence: baseConfidence,
      path: 'check',
      patternId: null,
      ruleIds,
      family: null,
      source: null,
      isSafety: false,
    };
  }

  const confidence = Math.min(...winners.map((caution) => caution.confidence));
  const builtinWinner = winners.find((caution) => caution.source === 'builtin');
  const packWinner = winners.find((caution) => caution.source === 'pack');
  const isSafety = builtinWinner !== undefined || packWinner !== undefined;

  return {
    verdict,
    confidence,
    // A built-in rule is a direct check in code, and that is the source this build can
    // guarantee without a pack, so it names the path even when a pack rule also matched.
    path: builtinWinner !== undefined ? 'check' : 'pattern',
    patternId: builtinWinner === undefined && packWinner !== undefined ? packWinner.ruleId : null,
    ruleIds,
    family: builtinWinner?.family ?? null,
    source: winners[0]!.source,
    isSafety,
  };
}

function allowReason(signals: ActionSignals): string {
  if (!signals.hasSignal) {
    return (
      'Nothing was supplied that a rule could match: no target text, no page element, no ' +
      'URL, nothing to enter and no command, so the guard reports its default of allow ' +
      `with low confidence. ${ADVISORY_NOTE}`
    );
  }
  if (signals.action === 'unknown') {
    return (
      `The action "${signals.rawAction}" is not one this build knows, so the guard reports ` +
      'its default of allow with low confidence and hands the decision to the model as ' +
      `needs_ai. ${ADVISORY_NOTE}`
    );
  }
  return (
    `No payment, deletion, sending, publishing, credential or command rule matched what this ` +
    `${signals.action} would do, so the guard reports its default of allow. ${ADVISORY_NOTE}`
  );
}

function cautionReason(resolved: ResolvedVerdict): string {
  const headline =
    resolved.family !== null
      ? FAMILY_SUMMARY[resolved.family]
      : resolved.source === 'pack'
        ? PACK_SUMMARY
        : LEARNED_SUMMARY;
  return `${headline} ${ADVISORY_NOTE} Safety rules matched: ${resolved.ruleIds.join(', ')}.`;
}

function buildReason(signals: ActionSignals, resolved: ResolvedVerdict): string {
  return resolved.verdict === 'allow' ? allowReason(signals) : cautionReason(resolved);
}

/**
 * Holds the verdict to the question this tool asks before anything is written, so a
 * verdict that does not fit is rejected rather than stored as if it had.
 *
 * The distribution requirement is switched off deliberately: this tool returns one
 * verdict with one stated confidence, not a probability over the three options, and a
 * distribution here would be a number with nothing behind it.
 */
function assertVerdictFitsQuestion(verdict: Verdict, confidence: number, path: DecisionPath): void {
  const result = validateAnswer(
    RISKY_ACTION_QUESTION,
    { value: verdict, confidence, path },
    { requireDistribution: false },
  );
  if (!result.success) {
    throw new SchemaViolationException(
      `Refusing to record a verdict this question cannot hold: ${result.reason}`,
      result.field,
      result.details,
    );
  }
}

/**
 * Runs the `action_guard` tool: one advisory verdict for one action, with a record of
 * it.
 *
 * Every verdict is logged through `core/log.ts`, with `is_safety` set when a safety rule
 * produced it, so the review queue and the audit trail see what the caller was told.
 * Redaction runs inside that log call, so a credential in the text an action would enter
 * is masked before it is stored and is never echoed in the reason.
 */
export async function executeActionGuard(
  args: ActionGuardInput,
  context: ActionGuardContext = {},
): Promise<ActionGuardOutput> {
  const startedAt = performance.now();
  const store = context.store ?? getDefaultStore();

  const signals = readActionSignals(args);
  const engine = context.patternEngine ?? getDefaultPatternEngine();
  const cautions = collectCautions(signals, engine);

  const baseConfidence =
    signals.action === 'unknown'
      ? UNKNOWN_ACTION_CONFIDENCE
      : signals.hasSignal
        ? ALLOW_CONFIDENCE
        : NO_SIGNAL_CONFIDENCE;

  const resolved = resolveVerdict(cautions, baseConfidence);
  const reason = buildReason(signals, resolved);

  // An action this build does not name is the model's to decide. A safety rule that
  // fired is not: it wins, and needs_ai stays false.
  const needsAi = resolved.verdict === 'allow' && signals.action === 'unknown';

  assertVerdictFitsQuestion(resolved.verdict, resolved.confidence, resolved.path);

  const latencyMs = Number((performance.now() - startedAt).toFixed(3));

  const logged = logDecision({
    question: RISKY_ACTION_QUESTION,
    answer: resolved.verdict,
    path: resolved.path,
    confidence: resolved.confidence,
    latencyMs,
    session: context.session ?? context.sessionId ?? null,
    store,
    // The caller's own arguments, so the record carries what was checked and not only
    // what came back. Redaction inside the log masks anything secret in there.
    input: args,
    url: signals.url,
    patternId: resolved.patternId,
    isSafety: resolved.isSafety,
    needsReview: resolved.verdict !== 'allow' || needsAi,
  });

  return {
    verdict: resolved.verdict,
    reason,
    rule_ids: resolved.ruleIds,
    decision_id: logged.id,
    confidence: resolved.confidence,
    path: resolved.path,
    latency_ms: latencyMs,
    advisory: true,
    needs_ai: needsAi,
    pattern_id: resolved.patternId,
  };
}
