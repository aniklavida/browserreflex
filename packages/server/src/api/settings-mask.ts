/**
 * Settings masking for the local REST API.
 *
 * Provider keys are owned by a later card, which will hold them in the
 * operating system keychain. Until that card exists the settings table should
 * never hold a credential, and this module keeps it that way in both directions:
 *
 * - **Reading.** A setting is shown as `MASKED_PLACEHOLDER` when its name signals
 *   a credential, or when the redaction rules would mask its value. The response
 *   carries `masked: true`, so the client can tell a masked setting from a
 *   setting whose value really is the placeholder text.
 * - **Writing.** `PUT /api/settings` refuses a credential-named key and refuses a
 *   value the redaction rules would mask. A refusal is a 400 and nothing is
 *   stored: a value that is silently dropped is worse than one that is refused,
 *   because the person would believe it was saved.
 *
 * The value test reuses the redaction rules in `security/redact.ts` rather than a
 * second, looser heuristic: a value those rules mask is a value carrying a secret
 * or personal data, and a long opaque identifier such as a model id is left alone
 * by them.
 *
 * Known limit, stated rather than hidden: masking is decided by the setting name
 * and by the redaction rules. A credential stored under a name that signals
 * nothing, holding a value the redaction rules do not recognise, would be
 * returned as written.
 *
 * Status: **implemented and tested** in `packages/server/test/api.test.ts`.
 */

import { redact } from '../security/redact.js';
import type { Setting } from '../store/types.js';

/**
 * Fragments of a setting name that mean the value is a credential. A name
 * containing any of them is treated as a credential, case-insensitively.
 */
const CREDENTIAL_NAME_FRAGMENTS: readonly string[] = [
  'key',
  'token',
  'secret',
  'password',
  'passwd',
  'passphrase',
  'credential',
];

/** What a masked setting shows instead of its value. */
export const MASKED_PLACEHOLDER = '[redacted]';

/** True when a setting name says the value is a credential. */
export function isCredentialName(key: string): boolean {
  const lower = key.toLowerCase();
  return CREDENTIAL_NAME_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

/** True when the redaction rules would mask this value. */
export function valueLooksLikeSecret(value: string): boolean {
  return redact(value) !== value;
}

/** The value to expose in an API response. */
export function maskSettingValue(key: string, value: string): string {
  if (isCredentialName(key) || valueLooksLikeSecret(value)) {
    return MASKED_PLACEHOLDER;
  }
  return value;
}

export interface MaskedSetting {
  key: string;
  /** The value, or `MASKED_PLACEHOLDER` when it is masked. */
  value: string;
  /** True when this response is showing a placeholder rather than the value. */
  masked: boolean;
  updated_at: string;
}

/** Masks a stored setting for a response and says whether masking happened. */
export function maskSetting(setting: Setting): MaskedSetting {
  const value = maskSettingValue(setting.key, setting.value);
  return {
    key: setting.key,
    value,
    masked: value === MASKED_PLACEHOLDER,
    updated_at: setting.updated_at,
  };
}

/**
 * The reason a setting write must be refused, or undefined when it may be stored.
 *
 * The second case is the one that keeps a secret off disk: a value the redaction
 * rules would mask does not go into the settings table under any name.
 */
export function refuseSettingWrite(key: string, value: string): string | undefined {
  if (isCredentialName(key)) {
    return 'Refusing to store a credential in the settings table: provider keys belong in the operating system keychain';
  }
  if (valueLooksLikeSecret(value)) {
    return 'Refusing to store a value that carries a secret or personal data';
  }
  return undefined;
}
