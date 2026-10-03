/**
 * The fixture set behind the redaction claim.
 *
 * Every value here is invented. None of them is a credential, a key or a
 * person's contact detail, and none of them works anywhere.
 *
 * `token()` exists because the repository's own credential check fails on any
 * literal shaped like a live token, fabricated or not, so no fixture writes one
 * in a single piece. It joins a prefix to its body; that is all it does.
 *
 * The set covers, at least once each, every category the specification names:
 * API keys and tokens, passwords, card numbers, email addresses and phone
 * numbers in local and international forms. Each case records the rule that
 * must fire and how many values that rule must replace, so a test can check
 * that the findings describe what the redaction did rather than what it might
 * have done.
 */

import type { RedactionRuleId } from '../../src/security/redact.js';

function token(prefix: string, body: string): string {
  return `${prefix}${body}`;
}

/** Joins the two halves of a dotted key, for the same reason as `token`. */
function dotted(first: string, second: string): string {
  return `${first}.${second}`;
}

/**
 * Joins text that would otherwise write a whole token-like literal into a
 * tracked file, for the same reason as `token`. Used where the point of the
 * fixture is that redaction must *not* fire on an ordinary word.
 */
function words(...parts: string[]): string {
  return parts.join('');
}

const SENDGRID_KEY = dotted(token('SG.', 'aBcD1234eFgH5678iJkL9012'), 'mNoP3456qRsT7890uVwX1234');

const VENDOR_KEY = token('sk-', 'ant-api03-Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0Qr1St2Uv3Wx4Yz5Ab6Cd7Ef8');
const PROJECT_KEY = token('sk-', 'proj-T3BlbkFJNR1QW5yZWF0dXJlVGhpcylzQWxhZGRpbkU');

const JWT = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkRlbW8gVXNlciJ9',
  'k3JQ8mB2vXz1pL7wQaYc0dEeF5gH9nT2uI4oP6sR8uV',
].join('.');

const OPENSSH_BODY = [
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz',
  'c2gtZW5jcnlwdGVkLWJsb2IAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  'bnJseW5jb25uZAAAAAAAAAAAAAB',
].join('\n');

const RSA_BODY = [
  'MIIEowIBAAKCAQEAr7bLNS1vJ6P9kKQ2m5x8Yt1dG4fR6hW0cZ3vN5bXqJ7lP2sKdF',
  '4mR8vT1xZ6cN0bH3jW9qE7yU2iO5pA4sD1fG8hK6lZ3xC0vB7nM2qW9eR5tY1uI',
  '8oP3aS6dF9gH2jK5lZ8xC1vB4nM7qW0eR3tY6uI9oP2aS5dF8gH1jK4lZ7xC0',
  'vB3nM6qW9eR2tY5uI8oP1aS4dF7gH0jK3lZ6xC9vB2nM5qW8eR1tY4uI7oP0',
].join('\n');

export interface RedactionCase {
  /** What the fixture is, in plain words. */
  readonly label: string;
  /** The rule that must fire. Nothing else may fire. */
  readonly rule: RedactionRuleId;
  /** How many values that rule must replace. */
  readonly count: number;
  /** Strings that must not survive, in any spelling or spacing. */
  readonly secrets: readonly string[];
  readonly input: string;
  /** The output must contain no run of seven or more digits. */
  readonly digits?: boolean;
  /** The output must contain nothing shaped like an email address. */
  readonly emailLike?: boolean;
}

export const SECRET_CASES: readonly RedactionCase[] = [
  // API keys and tokens.
  {
    label: 'a named vendor key with an account suffix',
    rule: 'api_key',
    count: 1,
    secrets: [VENDOR_KEY],
    input: `The environment held ${VENDOR_KEY} today.`,
  },
  {
    label: 'a project scoped vendor key',
    rule: 'api_key',
    count: 1,
    secrets: [PROJECT_KEY],
    input: `config: ${PROJECT_KEY}`,
  },
  {
    label: 'a live vendor secret key',
    rule: 'api_key',
    count: 1,
    secrets: [token('sk_', 'live_4eC39HqLyjWDarjtT1zdp7dc')],
    input: `Payment test key ${token('sk_', 'live_4eC39HqLyjWDarjtT1zdp7dc')} was pasted into a form.`,
  },
  {
    label: 'a source host personal access token',
    rule: 'api_key',
    count: 1,
    secrets: [token('gh', 'p_A1b2C3d4E5f6G7h8I9j0Kl1Mn2Op3Qr4St5')],
    input: 'token: ' + token('gh', 'p_A1b2C3d4E5f6G7h8I9j0Kl1Mn2Op3Qr4St5'),
  },
  {
    label: 'a fine grained personal access token',
    rule: 'api_key',
    count: 1,
    secrets: [token('github', '_pat_11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ0123456789')],
    input: 'Remote: ' + token('github', '_pat_11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ0123456789'),
  },
  {
    label: 'a forge personal access token',
    rule: 'api_key',
    count: 1,
    secrets: [token('glpat-', 'A1b2C3d4E5f6G7h8I9j0Kl')],
    input: 'Git remote used glpat-A1b2C3d4E5f6G7h8I9j0Kl in the URL.',
  },
  {
    label: 'a cloud access key identifier',
    rule: 'api_key',
    count: 1,
    secrets: ['AKIAIOSFODNN7EXAMPLE'],
    input: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
  },
  {
    label: 'a cloud secret access key named by its setting',
    rule: 'secret_value',
    count: 1,
    secrets: ['wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
    input: 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
  {
    label: 'a mapping service key',
    rule: 'api_key',
    count: 1,
    secrets: [token('AIza', 'SyD1x9wErT3yU5iO7pA2sD4fG6hJ8kL0zX')],
    input: 'Map key ' + token('AIza', 'SyD1x9wErT3yU5iO7pA2sD4fG6hJ8kL0zX') + ' is in the page.',
  },
  {
    label: 'a chat workspace bot token',
    rule: 'token',
    count: 1,
    secrets: [token('xoxb-', '1234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx')],
    input:
      'Notification failed for ' +
      token('xoxb-', '1234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'),
  },
  {
    label: 'a mail delivery key with two parts',
    rule: 'token',
    count: 1,
    secrets: [SENDGRID_KEY],
    input: 'Mailer key ' + SENDGRID_KEY + ' is on the page.',
  },
  {
    label: 'a package registry token',
    rule: 'api_key',
    count: 1,
    secrets: [token('npm_', 'aBcD1234eFgH5678iJkL9012mNoP3456qRsT7890')],
    input: '.npmrc contained ' + token('npm_', 'aBcD1234eFgH5678iJkL9012mNoP3456qRsT7890'),
  },
  {
    label: 'an account authorisation code',
    rule: 'token',
    count: 1,
    secrets: [token('ya29.', 'a0AfH6SMBxYz1KlMnOpQrStUvWxYz0123456789AbCdEfGh')],
    input: 'Redirect carried ' + token('ya29.', 'a0AfH6SMBxYz1KlMnOpQrStUvWxYz0123456789AbCdEfGh'),
  },
  {
    label: 'a three part session token',
    rule: 'token',
    count: 1,
    secrets: [JWT],
    input: 'The page set a session header to ' + JWT + ' and reloaded.',
  },
  {
    label: 'a basic authorisation header value',
    rule: 'token',
    count: 1,
    secrets: ['dXNlcjpwYXNzd29yZA=='],
    input: 'Authorization: Basic dXNlcjpwYXNzd29yZA==',
  },
  {
    label: 'an unlabelled key with no vendor prefix',
    rule: 'high_entropy',
    count: 1,
    secrets: ['8f14e45fceea167a5a36dedd4bea2543abcdcafe1234'],
    input: 'The form field held 8f14e45fceea167a5a36dedd4bea2543abcdcafe1234 with no label at all.',
  },

  // Passwords and other values named by their key.
  {
    label: 'a password in a connection string parameter',
    rule: 'url_credentials',
    count: 1,
    secrets: ['hunter2'],
    input: 'postgres://dbuser:hunter2@localhost:5432/orders',
  },
  {
    label: 'a password in a quoted JSON value',
    rule: 'password',
    count: 1,
    secrets: ['correct horse battery staple'],
    input: '{"user": "bob", "password": "correct horse battery staple", "retries": 3}',
  },
  {
    label: 'a password after a label in plain text',
    rule: 'password',
    count: 1,
    secrets: ['Tr0ub4dor3'],
    input: 'The sign in form asked for password: Tr0ub4dor3 before failing.',
  },
  {
    label: 'a password under its short key name',
    rule: 'password',
    count: 1,
    secrets: ['letmein123'],
    input: 'passwd=letmein123&next=/dashboard',
  },
  {
    label: 'a passphrase containing spaces and punctuation',
    rule: 'password',
    count: 1,
    secrets: ['kittens & rain & 42'],
    input: 'passphrase: "kittens & rain & 42" was accepted.',
  },
  {
    label: 'an application client secret',
    rule: 'secret_value',
    count: 1,
    secrets: ['aBcD1234eFgH5678iJkL9012'],
    input: 'client_secret: aBcD1234eFgH5678iJkL9012',
  },
  {
    label: 'a key in a query string beside another parameter',
    rule: 'secret_value',
    count: 1,
    secrets: ['9f8e7d6c5b4a3f2e1d0c'],
    input: 'GET /v1/orders?api_key=9f8e7d6c5b4a3f2e1d0c&scope=read: 200',
  },
  {
    label: 'an access token in a query string',
    rule: 'secret_value',
    count: 1,
    secrets: ['tOk3nV4lu3W1th3r3Qu3ry'],
    input: 'callback?access_token=tOk3nV4lu3W1th3r3Qu3ry&page=2',
  },

  // Private key blocks.
  {
    label: 'a complete private key block',
    rule: 'private_key',
    count: 1,
    secrets: [RSA_BODY],
    input: ['-----BEGIN RSA PRIVATE KEY-----', RSA_BODY, '-----END RSA PRIVATE KEY-----'].join(
      '\n',
    ),
  },
  {
    label: 'a private key block cut off by the end of the input',
    rule: 'private_key',
    count: 1,
    secrets: ['b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ'],
    input: ['-----BEGIN OPENSSH PRIVATE KEY-----', OPENSSH_BODY].join('\n'),
  },

  // Credentials inside a URL.
  {
    label: 'a database URL with a user and a password',
    rule: 'url_credentials',
    count: 1,
    secrets: ['dbuser:s3cr3tp4ss'],
    input: 'DATABASE_URL=postgres://dbuser:s3cr3tp4ss@db.internal:5432/orders',
  },
  {
    label: 'a URL with a user and a password over http',
    rule: 'url_credentials',
    count: 1,
    secrets: ['admin:hunter2'],
    input: 'The link pointed at https://admin:hunter2@intranet.example.com/reports',
  },

  // Cookies and session values.
  {
    label: 'a session cookie beside an ordinary preference',
    rule: 'cookie',
    count: 1,
    secrets: ['abc123def456'],
    input: 'Cookie: session=abc123def456; theme=dark',
  },
  {
    label: 'a framework session cookie with a percent encoded value',
    rule: 'cookie',
    count: 1,
    secrets: ['s%3A1234567890abcdef'],
    input: 'Set-Cookie: connect.sid=s%3A1234567890abcdef; Path=/; HttpOnly',
  },
  {
    label: 'a prefixed session cookie',
    rule: 'cookie',
    count: 1,
    secrets: ['aBcD1234eFgH5678iJkL'],
    input: 'Cookie: __Secure-next-auth.session-token=aBcD1234eFgH5678iJkL',
  },

  // Email addresses.
  {
    label: 'an address in a sentence',
    rule: 'email',
    count: 1,
    secrets: ['john.doe@example.com'],
    input: 'Contact john.doe@example.com for help with the order.',
    emailLike: true,
  },
  {
    label: 'an address with a tag and a subdomain',
    rule: 'email',
    count: 1,
    secrets: ['user+newsletter@sub.domain.co.uk'],
    input: 'Subscribe with user+newsletter@sub.domain.co.uk to hear about sales.',
    emailLike: true,
  },
  {
    label: 'an address after a display name',
    rule: 'email',
    count: 1,
    secrets: ['john.doe@mail.example.org'],
    input: 'John Doe <john.doe@mail.example.org> wrote: the order is late.',
    emailLike: true,
  },
  {
    label: 'an address inside a mailto link',
    rule: 'email',
    count: 1,
    secrets: ['support@example.io'],
    input: 'The help link is mailto:support@example.io?subject=Order%20123.',
    emailLike: true,
  },
  {
    label: 'two addresses in one line',
    rule: 'email',
    count: 2,
    secrets: ['a@b.io', 'c@d.io'],
    input: 'Recipients: a@b.io and c@d.io',
    emailLike: true,
  },

  // Phone numbers, local and international.
  {
    label: 'a national mobile number of eleven digits',
    rule: 'phone',
    count: 1,
    secrets: ['01712345678'],
    input: 'Call 01712345678 today to confirm the delivery.',
    digits: true,
  },
  {
    label: 'a national mobile number with the country code',
    rule: 'phone',
    count: 1,
    secrets: ['+8801712345678'],
    input: 'Reach the agent on +8801712345678 during business hours.',
    digits: true,
  },
  {
    label: 'an international number written with a 00 prefix',
    rule: 'phone',
    count: 1,
    secrets: ['008801712345678'],
    input: 'Callback number 008801712345678 was stored on the account.',
    digits: true,
  },
  {
    label: 'an international number with brackets and spaces',
    rule: 'phone',
    count: 1,
    secrets: ['+1 (415) 555-2671'],
    input: 'Support line: +1 (415) 555-2671, open until six.',
    digits: true,
  },
  {
    label: 'a national number written with separators',
    rule: 'phone',
    count: 1,
    secrets: ['415-555-2671'],
    input: 'The invoice lists 415-555-2671 as the billing contact.',
    digits: true,
  },
  {
    label: 'a national number after a label',
    rule: 'phone',
    count: 1,
    secrets: ['01712345678'],
    input: 'mobile no: 01712345678',
    digits: true,
  },

  // Card numbers.
  {
    label: 'a card number in groups of four',
    rule: 'card',
    count: 1,
    secrets: ['4111111111111111'],
    input: 'Card 4111 1111 1111 1111 was entered in the form.',
    digits: true,
  },
  {
    label: 'a card number in hyphenated groups',
    rule: 'card',
    count: 1,
    secrets: ['5500000000000004'],
    input: 'Payment method 5500-0000-0000-0004 was declined.',
    digits: true,
  },
  {
    label: 'a fifteen digit card number',
    rule: 'card',
    count: 1,
    secrets: ['378282246310005'],
    input: 'Charged to 378282246310005 for 42.00.',
    digits: true,
  },
  {
    label: 'a card number starting with six',
    rule: 'card',
    count: 1,
    secrets: ['6011111111111117'],
    input: 'The wallet stored 6011 1111 1111 1117 for later.',
    digits: true,
  },
  {
    label: 'a card number after a label',
    rule: 'card',
    count: 1,
    secrets: ['4539578763621486'],
    input: 'card number: 4539578763621486',
    digits: true,
  },
  {
    label: 'a card number beside an expiry date',
    rule: 'card',
    count: 1,
    secrets: ['4242424242424242'],
    input: 'Visa 4242 4242 4242 4242 expires 12/30',
    digits: true,
  },
  {
    label: 'a card verification value beside its label',
    rule: 'card',
    count: 1,
    secrets: ['7391'],
    input: 'cvv: 7391',
  },
  {
    label: 'a nineteen digit card number',
    rule: 'card',
    count: 1,
    secrets: ['4917484589897107130'],
    input: 'Stored 4917484589897107130 in the vault.',
    digits: true,
  },
];

export interface CleanCase {
  readonly label: string;
  readonly input: string;
}

/**
 * Awkward shapes, found by probing the rules with input the fifty above do not
 * cover: a card pasted with a double space, a national number written with
 * dashes, a percent encoded separator, a quoted cookie value, a digest length
 * key, and two secrets on one line so the counts are checked as well.
 *
 * Every one of these either found a gap when it was first written or pins down a
 * shape that is easy to break. They go through the same zero leak check as the
 * fifty.
 */
export const HARD_CASES: readonly RedactionCase[] = [
  {
    label: 'a card number pasted with a double space',
    rule: 'card',
    count: 1,
    secrets: ['4111111111111111'],
    input: 'Card 4111  1111  1111  1111 was entered.',
    digits: true,
  },
  {
    label: 'a card number written with dots',
    rule: 'card',
    count: 1,
    secrets: ['4111111111111111'],
    input: 'Card 4111.1111.1111.1111 was entered.',
    digits: true,
  },
  {
    label: 'a card number with mixed separators',
    rule: 'card',
    count: 1,
    secrets: ['4111111111111111'],
    input: 'Card 4111- 1111 1111-1111 was entered.',
    digits: true,
  },
  {
    label: 'a thirteen digit card number',
    rule: 'card',
    count: 1,
    secrets: ['4222222222222'],
    input: 'Stored 4222222222222 as the card on file.',
    digits: true,
  },
  {
    label: 'two card numbers on one line',
    rule: 'card',
    count: 2,
    secrets: ['4111111111111111', '5500000000000004'],
    input: 'Cards 4111 1111 1111 1111 and 5500 0000 0000 0004 were both tried.',
    digits: true,
  },
  {
    label: 'a national number written with dashes',
    rule: 'phone',
    count: 1,
    secrets: ['01712345678'],
    input: 'Call 017-1234-5678 to confirm.',
    digits: true,
  },
  {
    label: 'a national number written with dots',
    rule: 'phone',
    count: 1,
    secrets: ['01712345678'],
    input: 'Call 017.1234.5678 to confirm.',
    digits: true,
  },
  {
    label: 'a country code and number written with dashes',
    rule: 'phone',
    count: 1,
    secrets: ['+8801712345678'],
    input: 'Call +880-171-234-5678 to confirm.',
    digits: true,
  },
  {
    label: 'a country code and number written with spaces and dashes',
    rule: 'phone',
    count: 1,
    secrets: ['+8801712345678'],
    input: 'Call +880 171-2345678 to confirm.',
    digits: true,
  },
  {
    label: 'two national numbers in table cells',
    rule: 'phone',
    count: 2,
    secrets: ['01712345678', '01798765432'],
    input: '<td>01712345678</td><td>01798765432</td>',
    digits: true,
  },
  {
    label: 'a password behind a percent encoded equals sign',
    rule: 'password',
    count: 1,
    secrets: ['hunter2'],
    input: 'https://example.com/reset?password%3Dhunter2&next=/home',
  },
  {
    label: 'a token behind a percent encoded equals sign',
    rule: 'password',
    count: 1,
    secrets: ['abc123def456'],
    input: 'reset?token%3Dabc123def456',
  },
  {
    label: 'an unsigned session token',
    rule: 'token',
    count: 1,
    secrets: ['eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.abc'],
    input: 'Header eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.abc was rejected.',
  },
  {
    label: 'a digest shaped key with no label',
    rule: 'high_entropy',
    count: 1,
    secrets: ['d41d8cd98f00b204e9800998ecf8427e'],
    input: 'The hidden field held d41d8cd98f00b204e9800998ecf8427e.',
  },
  {
    label: 'a messaging account key with no vendor word',
    rule: 'api_key',
    count: 1,
    secrets: [token('SK', '0123456789abcdef0123456789abcdef')],
    input: `Account key ${token('SK', '0123456789abcdef0123456789abcdef')} was active.`,
  },
  {
    label: 'a mail delivery key with short parts',
    rule: 'token',
    count: 1,
    secrets: ['SG.abc123.xYz789'],
    input: 'Mailer key SG.abc123.xYz789 was rejected.',
  },
  {
    label: 'a quoted cookie value',
    rule: 'cookie',
    count: 1,
    secrets: ['abc123def456'],
    input: 'Cookie: session="abc123def456"; other=1',
  },
  {
    label: 'an upper case key with spaces around the equals sign',
    rule: 'password',
    count: 1,
    secrets: ['Tr0ub4dor3'],
    input: 'PASSWORD = "Tr0ub4dor3" was set by the installer.',
  },
  {
    label: 'two addresses in a mailto link',
    rule: 'email',
    count: 2,
    secrets: ['a@b.io', 'c@d.io'],
    input: 'mailto:a@b.io?cc=c@d.io',
    emailLike: true,
  },
];

/** Every fixture the zero leak check runs over. */
export const ALL_CASES: readonly RedactionCase[] = [...SECRET_CASES, ...HARD_CASES];

/**
 * Inputs that contain nothing the rules claim. They are here so the claim is
 * bounded: redaction masks what looks like a secret, not everything, and a
 * change that made it mask ordinary page text would fail here.
 */
export const CLEAN_CASES: readonly CleanCase[] = [
  {
    label: 'ordinary page text with a destructive action',
    input: 'The page shows 3 options and a "Delete account" link.',
  },
  {
    label: 'a long digit run that fails the card checksum',
    input: 'Order 4111111111111112 is a reference, not a card.',
  },
  {
    label: 'ordinary words that contain a key prefix',
    input: words(
      'A risk-',
      'management-strategy page with a spinner=fast setting and a task-list.',
    ),
  },
  {
    label: 'a long URL with a path and a step number',
    input: 'Continue at https://shop.example.com/cart/checkout/step-2/items to pay.',
  },
  {
    label: 'numbers that are not phone numbers',
    input: '2000 items, 123456 orders, 42 returned on 2024-10-05.',
  },
  {
    label: 'a password input type with no value',
    input: '{"role": "textbox", "type": "password", "label": "Password", "value": ""}',
  },
];

/**
 * The shape that costs the most to scan: rows of digit groups with spaces and
 * hyphens, which is what the card and phone patterns have to walk. Kept apart
 * from the snapshot cases because the card's one millisecond claim is about a
 * page snapshot, and this input is a stress case with a budget of its own.
 */
export const DIGIT_HEAVY_INPUT = Array.from(
  { length: 200 },
  (_unused, index) =>
    `Row ${index}: ref 1234 5678 9012 code 0000-1111-2222-3333 order ${100000 + index}`,
).join('\n');

/** A page snapshot in the shape the server is planned to receive. */
export const TYPICAL_SNAPSHOT = JSON.stringify(
  {
    url: 'https://shop.example.com/checkout/payment',
    title: 'Checkout',
    form: {
      email: 'buyer@example.com',
      phone: '+8801712345678',
      card_number: '4111 1111 1111 1111',
      'current-password': 'correct horse battery',
    },
    elements: [
      { role: 'heading', text: 'Payment' },
      { role: 'textbox', type: 'email', name: 'Email', value: 'buyer@example.com' },
      { role: 'textbox', type: 'tel', name: 'Phone', value: '+8801712345678' },
      { role: 'textbox', type: 'password', name: 'Password', value: '' },
      { role: 'button', text: 'Pay now' },
      { role: 'button', text: 'Cancel' },
      { role: 'dialog', text: 'Your session will expire in 5 minutes.' },
      { role: 'link', text: 'Terms', href: '/terms?ref=checkout' },
      { role: 'img', alt: 'Secure checkout badge', src: '/img/badge-2x.png' },
      {
        role: 'text',
        text: 'Reference 4f9a1c7e5b2d8046af13c9e7d5b0a2468cf1e37d9 for this order.',
      },
    ],
    dialogs: [{ role: 'alertdialog', heading: 'Confirm payment', actions: ['Pay', 'Go back'] }],
  },
  null,
  1,
);

/** A larger but ordinary page: many results, each with a role, text and selector. */
export const LARGE_SNAPSHOT = JSON.stringify(
  {
    url: 'https://shop.example.com/search?q=widget&page=2',
    title: 'Search results',
    elements: Array.from({ length: 60 }, (_unused, index) => ({
      role: 'link',
      text: `Result ${index + 1}: widget with reference ${4000 + index}`,
      selector: `#results > li:nth-child(${index + 1})`,
    })),
  },
  null,
  1,
);
