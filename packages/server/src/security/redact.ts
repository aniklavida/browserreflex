/**
 * Redaction of secrets and personal data, applied before anything is stored,
 * logged or exported.
 *
 * Status: **implemented and tested** for the rules in `REDACTION_RULES` below.
 * The test that backs that claim is `packages/server/test/redact.test.ts`
 * (a fixture set with a zero-leak assertion) and the performance claim is
 * measured in the same file. Anything not listed in `REDACTION_RULES` is not
 * covered by redaction and no claim is made about it.
 *
 * Design choices, each with a reason:
 *
 * - **A matched value is replaced whole.** No prefix, suffix or "last four
 *   digits" survives. A partial mask is still personal data, and a zero-leak
 *   guarantee is not possible with one.
 * - **Redaction fails closed.** A value that looks like a secret is masked even
 *   when it is not one. Over-masking costs a readable snapshot; under-masking
 *   writes a secret to disk. Both directions are covered by tests.
 * - **The mask keeps the surrounding shape.** A key, a label and the JSON or
 *   query structure around a masked value stay in place, so a stored snapshot
 *   still reads as a snapshot.
 * - **A finding names a rule and a count, never the matched text.** Findings go
 *   into decision records, so they must describe what happened without carrying
 *   the secret. `findings` is the list of rules that actually replaced
 *   something in this call, with the number of replacements each made.
 * - **The hash is taken from the original input.** Memory recognises an input it
 *   has answered for by hashing the exact original text, while what gets stored
 *   is the redacted text. See the limit recorded on `hashForMemoryLookup`.
 * - **Redaction is idempotent.** Running it on its own output changes nothing
 *   and reports no finding, because no mask character can start a match.
 *
 * This module has no dependencies beyond the Node standard library.
 */

import { createHash } from 'node:crypto';

/** Every rule this module can apply. A rule not listed here is not applied. */
export type RedactionRuleId =
  | 'private_key'
  | 'url_credentials'
  | 'api_key'
  | 'token'
  | 'password'
  | 'secret_value'
  | 'cookie'
  | 'email'
  | 'phone'
  | 'card'
  | 'high_entropy';

/** What a rule did in one call. Safe to store: it carries no matched text. */
export interface RedactionFinding {
  readonly rule: RedactionRuleId;
  readonly count: number;
}

export interface RedactionResult {
  /** The input with every matched value replaced by its mask. */
  readonly redacted: string;
  /** SHA-256 of the original input, for memory lookup. */
  readonly originalHash: string;
  /** The rules that replaced something, in the order they ran. */
  readonly findings: readonly RedactionFinding[];
}

const MASK = {
  private_key: '[REDACTED:PRIVATE_KEY]',
  url_credentials: '[REDACTED:URL_CREDENTIALS]',
  api_key: '[REDACTED:API_KEY]',
  token: '[REDACTED:TOKEN]',
  password: '[REDACTED:PASSWORD]',
  secret_value: '[REDACTED:SECRET]',
  cookie: '[REDACTED:COOKIE]',
  email: '[REDACTED:EMAIL]',
  phone: '[REDACTED:PHONE]',
  card: '[REDACTED:CARD]',
  high_entropy: '[REDACTED:SECRET]',
} as const satisfies Record<RedactionRuleId, string>;

/** The mask a rule writes. Two rules may share a mask; they never share an id. */
export function maskFor(rule: RedactionRuleId): string {
  return MASK[rule];
}

interface ReplacementContext {
  readonly match: string;
  readonly groups: readonly string[];
}

interface Rule {
  readonly id: RedactionRuleId;
  readonly pattern: RegExp;
  /** Cheap literal test. The pattern is only run when one of these is present. */
  readonly requires?: readonly string[];
  /** Keeps or rejects a candidate match. A rejected match is left as it was. */
  readonly accept?: (match: string, groups: readonly string[]) => boolean;
  /** Builds the replacement. Defaults to the rule's whole-value mask. */
  readonly build?: (context: ReplacementContext) => string;
}

/**
 * A value that follows a key, a label or an equals sign.
 *
 * `[]` and a quote in front of a mask are refused everywhere, so that an
 * existing mask can never be matched again. That is what makes a second pass a
 * no-op. The last alternative also refuses to start on a scheme word, so that a
 * value such as `Basic` in `Authorization: Basic <mask>` is not itself read as
 * a value.
 */
const VALUE = String.raw`(?:"(?!\[)[^"\n]*"|'(?!\[)[^'\n]*'|(?:Bearer|Basic|Token|Digest)\s+(?!\[)[^\s,;&)"'#\[\]]+|(?!(?:Bearer|Basic|Token|Digest)\b)[^\s,;&)"'#\[\]]+)`;

/** The closing quote, colon, equals sign or percent encoded equals sign of a key. */
const KEY_TAIL = String.raw`(["']?\s*(?::|=|%3[dD])\s*)`;

/** A key name that carries a secret, with any prefix such as `db_` or `user.`. */
function keyRule(id: 'password' | 'secret_value', names: string): Rule {
  const pattern = new RegExp(String.raw`([A-Za-z0-9_.-]*(?:${names}))${KEY_TAIL}(${VALUE})`, 'gi');
  return {
    id,
    pattern,
    requires: ['=', ':', '%3D', '%3d'],
    build: (context) => {
      // A quoted value keeps its quotes, so that a redacted JSON snapshot is
      // still JSON and a redacted query string is still parseable.
      return `${context.groups[0]}${context.groups[1]}${maskKeepingQuotes(
        context.groups[2] ?? '',
        MASK[id],
      )}`;
    },
  };
}

function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Puts a mask back inside the quotes a value had, so that a redacted JSON
 * document is still JSON and a redacted query string is still parseable.
 */
function maskKeepingQuotes(value: string, mask: string): string {
  const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : '';
  const closing = quote !== '' && value.endsWith(quote) ? quote : '';
  return `${quote}${mask}${closing}`;
}

/**
 * The Luhn checksum, used to tell a card number from any other long digit run.
 * A digit run that fails it is not a card and is left alone.
 */
function luhnValid(value: string): boolean {
  const digits = digitsOf(value);
  let sum = 0;
  let doubled = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (doubled) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubled = !doubled;
  }
  return sum % 10 === 0;
}

/**
 * A phone number of `min` to `max` digits, counted after separators are
 * removed. The count is the only shape test available, so the bound is what
 * keeps a card number out of this rule and a card number out of the phone mask.
 */
function isPhoneSized(match: string, min = 7, max = 15): boolean {
  const count = digitsOf(match).length;
  return count >= min && count <= max;
}

/**
 * The literal prefixes one rule needs before its pattern is worth running.
 *
 * They are written in two pieces because the repository's own credential check
 * greps tracked files for whole token prefixes, and a guard list is not a
 * credential.
 */
const SOURCE_HOST_PREFIXES: readonly string[] = [
  'gh' + 'p_',
  'gh' + 'o_',
  'gh' + 'u_',
  'gh' + 's_',
  'gh' + 'r_',
  'git' + 'hub_pat_',
];

/**
 * Rules, in the order they run.
 *
 * Order matters in three places, each marked below: a PEM block before the
 * key/value rules, phone numbers before card numbers, and card numbers before
 * the catch-all. A later rule never sees text a later mask replaced, because
 * no mask character can start a match.
 */
const REDACTION_RULES: readonly Rule[] = [
  // 1. A private key block, whole, complete or cut off by the end of the input.
  {
    id: 'private_key',
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
    requires: ['PRIVATE KEY'],
  },
  {
    id: 'private_key',
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*/g,
    requires: ['PRIVATE KEY'],
  },

  // 2. Credentials inside a URL, as in a database connection string. Only the
  //    user and password go; the host stays so the record is still useful.
  //    `[]` is excluded so a mask already in the text cannot match again.
  {
    id: 'url_credentials',
    pattern: /\b([a-z][a-z0-9+.-]{1,19}):\/\/[^\s/:@[\]]+:[^\s/@[\]]+@/gi,
    requires: ['://'],
    build: (context) => `${context.groups[0]}://${MASK.url_credentials}@`,
  },

  // 3a. Keys that name their vendor by prefix. Each rule carries the literal
  //     prefix it needs, so its pattern is skipped on text that cannot match.
  //     Each pattern starts at a word boundary, so that an ordinary word
  //     containing a prefix, such as `risk-management`, is not masked.
  {
    id: 'api_key',
    pattern: /\bsk-(?:ant-)?(?:api\d{2}-)?[A-Za-z0-9_-]{16,}/g,
    requires: ['sk-'],
  },
  {
    id: 'api_key',
    pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
    requires: ['sk_', 'rk_', 'pk_'],
  },
  {
    id: 'api_key',
    pattern: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/g,
    requires: SOURCE_HOST_PREFIXES,
  },
  {
    id: 'api_key',
    pattern: /\bglpat-[A-Za-z0-9_-]{16,}/g,
    requires: ['glpat-'],
  },
  {
    id: 'api_key',
    pattern: /\bA[KS]IA[0-9A-Z]{16}\b/g,
    requires: ['AKIA', 'ASIA'],
  },
  {
    id: 'api_key',
    pattern: /\bAIza[0-9A-Za-z_-]{20,}/g,
    requires: ['AIza'],
  },
  {
    id: 'api_key',
    pattern: /\bkey-[0-9a-f]{32}/g,
    requires: ['key-'],
  },
  {
    id: 'api_key',
    pattern: /\bdop_v1_[0-9a-f]{64}/g,
    requires: ['dop_v1_'],
  },
  {
    id: 'api_key',
    pattern: /\bhf_[A-Za-z0-9]{30,}/g,
    requires: ['hf_'],
  },
  {
    id: 'api_key',
    pattern: /\bnpm_[A-Za-z0-9]{30,}/g,
    requires: ['npm_'],
  },
  {
    id: 'api_key',
    pattern: /\bnx[a-z]{2}_[A-Za-z0-9_-]{20,}/g,
    requires: ['nxat_', 'nxbt_', 'nxsb_'],
  },
  {
    // A messaging account key: two upper case letters and thirty two hex digits.
    id: 'api_key',
    pattern: /\bSK[0-9a-f]{32}\b/g,
    requires: ['SK'],
  },

  // 3b. Tokens that name their vendor, then the two shapes that name nothing.
  {
    id: 'token',
    pattern: /\bya29\.[A-Za-z0-9_-]{10,}/g,
    requires: ['ya29.'],
  },
  {
    id: 'token',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    requires: ['xox'],
  },
  {
    id: 'token',
    pattern: /\bSG\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
    requires: ['SG.'],
  },
  {
    id: 'token',
    pattern: /\bntn_[A-Za-z0-9]{20,}/g,
    requires: ['ntn_'],
  },
  // A JSON web token: base64url segments joined by dots, the last of which may
  // be empty when the token is unsigned. Taken before the authorisation rule so
  // the whole token is masked rather than three separate pieces.
  {
    id: 'token',
    pattern: /\beyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g,
    requires: ['eyJ'],
  },
  // An authorisation header value. The scheme word stays; the value goes.
  {
    id: 'token',
    pattern: /\b(Bearer|Basic|Digest)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    requires: ['Bearer', 'Basic', 'Digest'],
    build: (context) => `${context.groups[0]} ${MASK.token}`,
  },

  // 4. A cookie or session value. The name stays so the record still shows that
  //    a session was present. This runs before the key rules so that a name
  //    such as `session-token` is reported as the session value it is.
  {
    id: 'cookie',
    pattern:
      /(^|[\s;,("'])((?:__Secure-[\w-]+|__Host-[\w-]+|[\w.-]*(?:session|csrftoken|csrf|xsrf|auth|jwt|sid)[\w.-]*)=)("(?!\[)[^"\n]*"|[^;\s,"'[\]]+)/gim,
    requires: ['='],
    build: (context) =>
      `${context.groups[0]}${context.groups[1]}${maskKeepingQuotes(
        context.groups[2] ?? '',
        MASK.cookie,
      )}`,
  },

  // 5. A secret named by its key, in plain text, in JSON or in a query string.
  //    The named key rule runs first so that a key such as `client_secret` is
  //    reported under the key rule rather than under the general password rule.
  keyRule(
    'secret_value',
    'api[_-]?key|apikey|access[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|session[_-]?token|client[_-]?secret|app[_-]?secret|private[_-]?key|encryption[_-]?key|signing[_-]?key|subscription[_-]?key|authorization|x-api-key|x-auth-token|aws_secret_access_key|aws_session_token',
  ),
  keyRule('password', 'pass(?:word|wd)?|pwd|passphrase|pin|otp|secret|token'),

  // 6. An email address, wherever it appears including mailto links.
  {
    id: 'email',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g,
    requires: ['@'],
  },

  // 7. Phone numbers, before card numbers. An international number with its
  //    country code can be 13 digits and can pass the Luhn check, so the more
  //    specific rule has to run first. The lookbehind keeps `2000 123456` from
  //    being read as an international number starting at its second digit.
  {
    id: 'phone',
    pattern: /(?<![\dA-Za-z])\+ ?[\d(][\d() .-]{5,19}\d/g,
    requires: ['+'],
    accept: (match) => isPhoneSized(match),
  },
  // 7b. The same for the `00` form of an international prefix. No separator is
  //     allowed inside it, because a run of zeros after a space is far more
  //     likely to be a group of digits in a card number than a country code.
  {
    id: 'phone',
    pattern: /(?<![\dA-Za-z-])00\d{7,13}\b/g,
    requires: ['00'],
    accept: (match) => isPhoneSized(match, 9, 15),
  },
  {
    id: 'phone',
    pattern:
      /\b((?:phone(?:[ _-]?number)?|mobile(?:[ _-]?no\.?)?|tel(?:ephone)?|msisdn|whatsapp|hotline|contact[ _-]?number)["']?\s*[:=]\s*)(\+?[\d(][\d() .-]{5,19}\d)/gi,
    requires: [':', '=', '%3D', '%3d'],
    accept: (_match, groups) => isPhoneSized(groups[1]),
    build: (context) => `${context.groups[0]}${MASK.phone}`,
  },
  //  A national number written as eleven digits starting 01, with or without the
  //  country code, with spaces, dots or hyphens between the digits. Without a
  //  plus sign a 13-digit run can reach the card rule, so it is claimed here.
  {
    id: 'phone',
    pattern: /\b01(?:[ .-]?\d){9}\b/g,
    requires: ['01'],
    accept: (match) => isPhoneSized(match, 11, 11),
  },
  {
    id: 'phone',
    pattern: /\b8801(?:[ .-]?\d){9}\b/g,
    requires: ['8801'],
    accept: (match) => isPhoneSized(match, 13, 13),
  },
  {
    id: 'phone',
    pattern: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    accept: (match) => isPhoneSized(match, 10, 10),
  },

  // 8. A card number: thirteen to nineteen digits that pass the Luhn check.
  //    Groups may be separated by a space, a dot or a hyphen, one character at
  //    a time, so that a number pasted with a double space is still masked.
  {
    id: 'card',
    pattern: /\b\d(?:[ .-]{0,2}\d){12,18}\b/g,
    accept: (match) => {
      const digits = digitsOf(match);
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
    },
  },
  // 8b. A card value named by its label. The verification value is three digits
  //     and never passes the checksum above, so the label is all there is to go
  //     on. This masks on the label alone and therefore fails closed.
  {
    id: 'card',
    pattern:
      /\b((?:card[ _-]?number|cardno|card[ _-]?code|pan|cvv2?|cvc2?|csc|security[ _-]?code)["']?\s*[:=]\s*)(\d[\d -]{1,21}\d)/gi,
    requires: [':', '=', '%3D', '%3d'],
    accept: (_match, groups) => digitsOf(groups[1]).length >= 3,
    build: (context) => `${context.groups[0]}${MASK.card}`,
  },

  // 9. Anything else long enough and mixed enough to be a key: thirty two
  //    characters or more, with at least one digit and one letter. Thirty two
  //    is where a checksum, a digest or a generated key starts. Runs of letters
  //    alone, such as a long class name, are left alone, and so is a run shaped
  //    like a host or a file path, which is not a key.
  {
    id: 'high_entropy',
    pattern: /[A-Za-z0-9+/_=-]{32,}/g,
    accept: (match) =>
      /[0-9]/.test(match) && /[A-Za-z]/.test(match) && !/\.[A-Za-z0-9]/.test(match),
  },
];

/** Counts the capture groups of a pattern, once per pattern. */
const GROUP_COUNTS = new WeakMap<RegExp, number>();

function captureGroupCount(pattern: RegExp): number {
  const cached = GROUP_COUNTS.get(pattern);
  if (cached !== undefined) return cached;
  const count = new RegExp(`${pattern.source}|`).exec('')!.length - 1;
  GROUP_COUNTS.set(pattern, count);
  return count;
}

function applyRule(text: string, rule: Rule, counts: Map<RedactionRuleId, number>): string {
  if (rule.requires !== undefined && !rule.requires.some((literal) => text.includes(literal))) {
    return text;
  }
  const groupCount = captureGroupCount(rule.pattern);
  const mask = MASK[rule.id];
  let count = 0;
  rule.pattern.lastIndex = 0;
  const result = text.replace(rule.pattern, (...args: unknown[]) => {
    const match = String(args[0]);
    const groups = args.slice(1, 1 + groupCount).map((group) => String(group));
    if (rule.accept !== undefined && !rule.accept(match, groups)) {
      return match;
    }
    count += 1;
    if (rule.build !== undefined) {
      return rule.build({ match, groups });
    }
    return mask;
  });
  if (count > 0) {
    counts.set(rule.id, (counts.get(rule.id) ?? 0) + count);
  }
  return result;
}

function redactInternal(text: string): { redacted: string; findings: RedactionFinding[] } {
  const counts = new Map<RedactionRuleId, number>();
  let current = text;
  for (const rule of REDACTION_RULES) {
    current = applyRule(current, rule, counts);
  }
  // One finding per rule that fired, in rule order, with the total count across
  // every pattern that rule uses. A rule that replaced nothing is not listed:
  // listing it would describe work that did not happen.
  const findings: RedactionFinding[] = [];
  const reported = new Set<RedactionRuleId>();
  for (const rule of REDACTION_RULES) {
    if (reported.has(rule.id)) continue;
    reported.add(rule.id);
    const count = counts.get(rule.id);
    if (count !== undefined) {
      findings.push({ rule: rule.id, count });
    }
  }
  return { redacted: current, findings };
}

/**
 * Masks secrets and personal data in a string.
 *
 * Use this on anything that will be stored, logged or exported. Nothing the
 * rules match survives; nothing else is touched.
 */
export function redact(text: string): string {
  return redactInternal(text).redacted;
}

/**
 * The same masking as `redact`, with the hash of the original input and the
 * list of rules that fired.
 *
 * `findings` describes this call and nothing else: a rule is listed if and only
 * if it replaced something, with the number of values it replaced. A decision
 * record built from these findings describes what redaction did, not what it
 * might have done.
 */
export function redactWithHash(text: string): RedactionResult {
  const { redacted, findings } = redactInternal(text);
  return { redacted, originalHash: hashForMemoryLookup(text), findings };
}

/**
 * SHA-256 of the input, for recognising an input that has been answered for
 * before without keeping the input itself.
 *
 * Known limit, and it is a real one: a hash keeps the raw value out of the
 * database, but it is not a secret. A wordlist of common email addresses, card
 * numbers or short passwords can be enumerated against it, and a short input
 * has a small space to search. This function is for lookup by exact match; it
 * is not a defence against someone who already holds the database and a
 * wordlist. Anything stronger belongs with the key storage work, where a key
 * from the operating system keychain can key the hash.
 */
export function hashForMemoryLookup(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The rules this module applies, in the order they run. */
export function redactionRules(): readonly RedactionRuleId[] {
  return [...new Set(REDACTION_RULES.map((rule) => rule.id))];
}
