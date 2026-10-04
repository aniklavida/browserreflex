/**
 * BrowserReflex server entry point and scaffold helpers.
 *
 * Core claims and invariants:
 * - The safety check is advisory; it never prevents an agent from acting.
 * - Claims use the four permitted states: implemented and tested, experimental, planned, unsupported.
 */

export const SCAFFOLD_STATUS = 'implemented and tested';

/**
 * Returns true indicating that the safety check is advisory.
 * Per docs/SPEC.md and docs/ARCHITECTURE.md, safety checks provide advisory signals
 * and do not enforce host-level prevention.
 */
export function isSafetyAdvisory(): boolean {
  return true;
}

export {
  hashForMemoryLookup,
  redact,
  redactWithHash,
  type RedactionFinding,
  type RedactionResult,
  type RedactionRuleId,
} from './security/redact.js';
export {
  DATA_KEY_FILE_NAME,
  HIDDEN_SEGMENT,
  KEYCHAIN_BACKEND_STATUS,
  KEYCHAIN_SERVICE,
  KEYS_FILE_NAME,
  KEY_STORE_STATUS,
  KeyStoreError,
  MASK_PREFIX_LENGTH,
  MASK_SUFFIX_LENGTH,
  MAX_KEY_LENGTH,
  MIN_PARTIAL_MASK_LENGTH,
  createFileKeyStore,
  createKeychainKeyStore,
  getDefaultKeysDirectory,
  isKeychainAvailable,
  maskKeyValue,
  resolveKeyStore,
  summarizeKey,
  type FileKeyStoreOptions,
  type KeyStore,
  type KeyStoreBackend,
  type KeyStoreErrorCode,
  type KeySummary,
  type KeychainEntry,
  type KeychainEntryFactory,
  type KeychainKeyStoreOptions,
  type ResolveKeyStoreOptions,
  type ResolvedKeyStore,
} from './security/keys.js';
export * from './core/schema.js';
export * from './core/memory.js';
export * from './core/log.js';
export * from './core/router.js';
export * from './core/thresholds.js';
export * from './tools/decide.js';
export * from './tools/submit_answers.js';
export * from './store/index.js';
export * from './patterns/index.js';
export * from './adapters/index.js';
