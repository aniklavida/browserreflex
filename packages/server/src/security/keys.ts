/**
 * Key storage for BYOK provider keys.
 *
 * Claims, and nothing beyond them:
 *
 * - The encrypted file store and the masking rules are **implemented and
 *   tested**. The test that backs that claim is
 *   `packages/server/test/keys.test.ts`.
 * - The operating system keychain backend is **experimental**. A set, get and
 *   delete round trip was run by hand on macOS; no claim is made about Linux or
 *   Windows, because neither was run. `resolveKeyStore` uses the keychain only
 *   when the binding loads and answers a probe, and otherwise returns the file
 *   store with `fellBack: true`, so no caller is told a keychain is in use when
 *   it is not.
 *
 * Invariants this module holds, each with a named test:
 *
 * - **A key is never written in plaintext.** The file store holds one
 *   AES-256-GCM ciphertext and nothing else that carries a key. The test reads
 *   the raw bytes of every file in the directory and looks for the key in every
 *   spelling a file could plausibly carry it in, including base64 and hex at
 *   every alignment, and not only as the whole key but as a run of twenty of its
 *   characters.
 * - **The database never holds a key.** This module imports nothing from the
 *   store and takes no database handle. The test opens a real database, sets a
 *   key, and asserts that the `settings` table is empty and that neither the
 *   database file nor its write-ahead log contains the key.
 * - **No API shape can carry a full key.** `summarizeKey` returns a type with no
 *   field a key could occupy, so a response built from it cannot leak one.
 *   `getKey` is for calling a provider with, not for showing one.
 * - **Masking shows at most half of a key, and nothing at all of a short one.**
 *   The hidden run is a fixed length, so a mask does not disclose the key's
 *   length either.
 * - **Nothing is repaired silently.** A provider id that is not lower case, an
 *   empty key, a key with a control character, a key with leading or trailing
 *   whitespace and an over-long key are all rejected with a `KeyStoreError`
 *   naming the rule. None of them is normalised.
 * - **A store that cannot be read says so.** A changed ciphertext, a wrong data
 *   key or a mangled envelope raises `corrupt_store`. Reporting an unreadable
 *   store as an empty one would describe a lost key as a missing one.
 *
 * Known limit, and it is a real one: the file store's data key lives in a second
 * file next to the ciphertext, both readable only by the owner. That keeps a key
 * out of a backup, a synced folder, a screenshot, a crash report and any tool
 * that reads this directory, and it does **not** keep a key from another program
 * running as the same user, who can read both files. Only the operating system
 * keychain closes that gap, which is why it is the preferred backend where it
 * works.
 *
 * This module uses the Node standard library and one native keychain binding.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The claim this module makes about the file store and the masking rules. */
export const KEY_STORE_STATUS = 'implemented and tested';

/** The claim this module makes about the operating system keychain backend. */
export const KEYCHAIN_BACKEND_STATUS = 'experimental';

/** Where a key is kept. */
export type KeyStoreBackend = 'keychain' | 'file';

/** Why a store call failed. Every code names a rule that was broken. */
export type KeyStoreErrorCode =
  'invalid_provider' | 'invalid_key' | 'corrupt_store' | 'backend_unavailable';

export class KeyStoreError extends Error {
  public readonly code: KeyStoreErrorCode;

  constructor(code: KeyStoreErrorCode, message: string) {
    super(message);
    this.name = 'KeyStoreError';
    this.code = code;
  }
}

/**
 * One keychain item, as this module uses it. The item type of the keychain
 * binding satisfies this shape; a test supplies its own, so no test has to reach
 * a real keychain to cover this file.
 */
export interface KeychainEntry {
  setPassword(password: string): Promise<void>;
  getPassword(): Promise<string | null | undefined>;
  deletePassword(): Promise<boolean>;
}

/** Builds the keychain item for one account. */
export type KeychainEntryFactory = (service: string, account: string) => KeychainEntry;

export interface KeyStore {
  /** Where this store keeps keys. */
  readonly backend: KeyStoreBackend;
  /** Stores a key, replacing any key already held for the provider. */
  setKey(provider: string, key: string): Promise<void>;
  /**
   * Returns the full key. **For calling the provider with, never for showing
   * one.** Use `summarizeKey` for anything an agent, a log line or an API
   * response will carry.
   */
  getKey(provider: string): Promise<string | null>;
  hasKey(provider: string): Promise<boolean>;
  /** The masked form of the stored key, or an empty string when none is stored. */
  maskKey(provider: string): Promise<string>;
  /** Returns true when a key was removed and false when there was none. */
  deleteKey(provider: string): Promise<boolean>;
}

/** Characters shown at the front of a long key, as `maskKeyValue` shows them. */
export const MASK_PREFIX_LENGTH = 7;

/** Characters shown at the end of a long key, as `maskKeyValue` shows them. */
export const MASK_SUFFIX_LENGTH = 4;

/**
 * Shortest key that may be shown partially.
 *
 * It is twice the number of characters a partial mask shows, so a partial mask
 * never reveals more than half a key. Every provider key in use is far longer
 * than this; a shorter one is shown as dots alone.
 */
export const MIN_PARTIAL_MASK_LENGTH = 2 * (MASK_PREFIX_LENGTH + MASK_SUFFIX_LENGTH);

/**
 * The run that stands in for what is hidden. Its length is fixed, so a mask does
 * not disclose how long the key is.
 */
export const HIDDEN_SEGMENT = '.'.repeat(8);

/** Longest key accepted. No provider issues a key anywhere near this long. */
export const MAX_KEY_LENGTH = 4096;

/** A provider id: lower case, and nothing that could name a path or a file. */
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Masks a key for display.
 *
 * A key of at least `MIN_PARTIAL_MASK_LENGTH` characters keeps its first
 * `MASK_PREFIX_LENGTH` and last `MASK_SUFFIX_LENGTH` characters with dots in
 * between, which is at most half the key. Anything shorter shows dots alone. The
 * result is always strictly shorter than the key, so it can never be the key.
 */
export function maskKeyValue(key: string | null | undefined): string {
  if (key === null || key === undefined) return '';
  if (key.length < MIN_PARTIAL_MASK_LENGTH) return HIDDEN_SEGMENT;
  return `${key.slice(0, MASK_PREFIX_LENGTH)}${HIDDEN_SEGMENT}${key.slice(-MASK_SUFFIX_LENGTH)}`;
}

/**
 * Everything an API, a tool response or a log line may say about one provider's
 * key. There is no field here that a full key could occupy.
 */
export interface KeySummary {
  readonly provider: string;
  readonly present: boolean;
  readonly masked: string;
}

/**
 * The only shape this module offers for showing the state of a key. Build a
 * response from a `KeySummary` and no full key can appear in it.
 */
export async function summarizeKey(store: KeyStore, provider: string): Promise<KeySummary> {
  assertProvider(provider);
  const present = await store.hasKey(provider);
  return { provider, present, masked: present ? await store.maskKey(provider) : '' };
}

/**
 * Rejects a provider id that is not a plain lower-case name.
 *
 * Upper case is rejected rather than lowered, because lowering it would let
 * `Anthropic` and `anthropic` become two accounts and write a key to the wrong
 * one. Nothing of the value is echoed back, so this message is safe to log even
 * when the caller passed something that was not a provider id at all.
 */
function assertProvider(provider: string): string {
  if (typeof provider !== 'string' || !PROVIDER_PATTERN.test(provider)) {
    throw new KeyStoreError(
      'invalid_provider',
      'A provider id must be 1 to 64 characters of a-z, 0-9, dot, underscore or dash, ' +
        'starting with a letter or digit. Received ' +
        (typeof provider === 'string' ? `${provider.length} characters.` : `${typeof provider}.`),
    );
  }
  return provider;
}

/** Whether a string holds a C0 or C7 control character, such as a newline. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Rejects a key this module will not store.
 *
 * Whitespace is rejected and never trimmed. A key pasted with a trailing newline
 * is a broken key, and trimming it would be a repair the user was not told about.
 */
function assertKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new KeyStoreError('invalid_key', 'A key must be a non-empty string.');
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new KeyStoreError(
      'invalid_key',
      `A key must be at most ${MAX_KEY_LENGTH} characters; received ${key.length}.`,
    );
  }
  if (hasControlCharacter(key)) {
    throw new KeyStoreError(
      'invalid_key',
      'A key must not contain a control character, which includes a newline and a tab.',
    );
  }
  if (key !== key.trim()) {
    throw new KeyStoreError(
      'invalid_key',
      'A key must not begin or end with whitespace, and is not trimmed for you.',
    );
  }
  return key;
}

/** The message of an unknown thrown value, with no stack and no cause chain. */
function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

// --------------------------------------------------------------------------
// Encrypted file store
// --------------------------------------------------------------------------

/** The encrypted envelope as written to disk. It carries no plaintext. */
interface EncryptedEnvelope {
  readonly version: 1;
  readonly algorithm: 'aes-256-gcm';
  /** Base64, twelve bytes. Fresh for every write. */
  readonly iv: string;
  /** Base64, sixteen bytes: the authentication tag. */
  readonly tag: string;
  /** Base64: the AES-256-GCM ciphertext of a `PlaintextEnvelope`. */
  readonly ciphertext: string;
}

/** What the ciphertext decrypts to. */
interface PlaintextEnvelope {
  readonly version: 1;
  readonly keys: Record<string, string>;
}

/** Name of the file holding the encrypted envelope. */
export const KEYS_FILE_NAME = 'keys.enc.json';

/** Name of the file holding the random data key, kept apart from the envelope. */
export const DATA_KEY_FILE_NAME = 'keys.dat';

const ENVELOPE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const DATA_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIRECTORY = 0o700;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Decodes base64 strictly, so a mangled envelope is reported and not guessed at. */
function decodeBase64(value: string, expectedBytes: number | null, field: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new KeyStoreError(
      'corrupt_store',
      `The envelope has a malformed ${field} of ${value.length} characters.`,
    );
  }
  if (expectedBytes !== null && decoded.length !== expectedBytes) {
    throw new KeyStoreError(
      'corrupt_store',
      `The envelope has a ${field} of ${decoded.length} bytes; expected ${expectedBytes}.`,
    );
  }
  return decoded;
}

function requireStringField(record: Record<string, unknown>, field: string, what: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new KeyStoreError('corrupt_store', `The ${what} has no ${field}.`);
  }
  return value;
}

function readEnvelope(path: string): EncryptedEnvelope {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new KeyStoreError('corrupt_store', `The envelope could not be read: ${messageOf(cause)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KeyStoreError('corrupt_store', 'The envelope is not valid JSON.');
  }
  if (!isPlainObject(parsed)) {
    throw new KeyStoreError('corrupt_store', 'The envelope is not a JSON object.');
  }
  if (parsed.version !== ENVELOPE_VERSION) {
    throw new KeyStoreError(
      'corrupt_store',
      `The envelope declares version ${String(parsed.version)}; this build reads version ${ENVELOPE_VERSION}.`,
    );
  }
  if (parsed.algorithm !== ALGORITHM) {
    throw new KeyStoreError(
      'corrupt_store',
      `The envelope declares algorithm ${String(parsed.algorithm)}; this build reads ${ALGORITHM}.`,
    );
  }
  const iv = requireStringField(parsed, 'iv', 'envelope');
  const tag = requireStringField(parsed, 'tag', 'envelope');
  const ciphertext = requireStringField(parsed, 'ciphertext', 'envelope');
  // Validated here, so that a malformed envelope is reported from one place with
  // one message rather than from inside the cipher below.
  decodeBase64(iv, IV_BYTES, 'initialisation vector');
  decodeBase64(tag, TAG_BYTES, 'authentication tag');
  decodeBase64(ciphertext, null, 'ciphertext');
  return { version: ENVELOPE_VERSION, algorithm: ALGORITHM, iv, tag, ciphertext };
}

/** Decrypts an envelope with the data key, or throws `corrupt_store`. */
function openEnvelope(envelope: EncryptedEnvelope, dataKey: Buffer): PlaintextEnvelope {
  const decipher = createDecipheriv(
    ALGORITHM,
    dataKey,
    decodeBase64(envelope.iv, IV_BYTES, 'initialisation vector'),
  );
  decipher.setAuthTag(decodeBase64(envelope.tag, TAG_BYTES, 'authentication tag'));
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([
      decipher.update(decodeBase64(envelope.ciphertext, null, 'ciphertext')),
      decipher.final(),
    ]);
  } catch (cause) {
    // AES-256-GCM fails authentication when the data key is wrong or a byte was
    // changed. Reporting "no key stored" here would say a key was never set when
    // in fact it cannot be read, which is the misdescription this project treats
    // as its worst failure.
    throw new KeyStoreError(
      'corrupt_store',
      `The envelope did not authenticate with its data key, so it cannot be read: ${messageOf(cause)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new KeyStoreError('corrupt_store', 'The decrypted envelope is not valid JSON.');
  }
  if (
    !isPlainObject(parsed) ||
    parsed.version !== ENVELOPE_VERSION ||
    !isPlainObject(parsed.keys)
  ) {
    throw new KeyStoreError(
      'corrupt_store',
      'The decrypted envelope does not have the shape this build reads.',
    );
  }
  const keys: Record<string, string> = {};
  for (const [provider, value] of Object.entries(parsed.keys)) {
    if (typeof value !== 'string') {
      throw new KeyStoreError(
        'corrupt_store',
        `The key for provider ${JSON.stringify(provider)} is not a string in the decrypted envelope.`,
      );
    }
    keys[provider] = value;
  }
  return { version: ENVELOPE_VERSION, keys };
}

/** Writes a file only its owner can read, whatever the umask says. */
function writeOwnerOnly(path: string, data: Buffer): void {
  writeFileSync(path, data, { mode: OWNER_ONLY_FILE });
  // `mode` applies only when the file is created, so an existing file keeps
  // whatever permissions it had. This makes the outcome the same either way.
  chmodSync(path, OWNER_ONLY_FILE);
}

export interface FileKeyStoreOptions {
  /** Directory holding both files. Injected so a test never writes to a real home. */
  readonly directory: string;
  /** Overrides the envelope file name, for a test that inspects a known path. */
  readonly keysFileName?: string;
  /** Overrides the data key file name, for a test that inspects a known path. */
  readonly dataKeyFileName?: string;
}

/**
 * A key store that keeps every key in one AES-256-GCM ciphertext.
 *
 * The data key is 32 random bytes in its own file, readable only by the owner. It
 * is used as the AES key directly rather than through a password hash: it is
 * already random, so a hash would add nothing but a delay.
 *
 * Every call re-reads and re-decrypts the envelope. A provider key is read once
 * per provider call, so caching a secret in memory longer than that is not worth
 * the cost.
 */
export function createFileKeyStore(options: FileKeyStoreOptions): KeyStore {
  const directory = options.directory;
  const keysPath = join(directory, options.keysFileName ?? KEYS_FILE_NAME);
  const dataKeyPath = join(directory, options.dataKeyFileName ?? DATA_KEY_FILE_NAME);

  function ensureDirectory(): void {
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true, mode: OWNER_ONLY_DIRECTORY });
    }
  }

  function readDataKey(): Buffer | null {
    if (!existsSync(dataKeyPath)) return null;
    const dataKey = readFileSync(dataKeyPath);
    if (dataKey.length !== DATA_KEY_BYTES) {
      throw new KeyStoreError(
        'corrupt_store',
        `The data key file holds ${dataKey.length} bytes; expected ${DATA_KEY_BYTES}.`,
      );
    }
    return dataKey;
  }

  /** The keys currently stored, or an empty set when nothing is stored yet. */
  function load(): Record<string, string> {
    if (!existsSync(keysPath)) return {};
    const dataKey = readDataKey();
    if (dataKey === null) {
      // The ciphertext is there and the key that opens it is not. Reporting an
      // empty store here would say a key was never set when it cannot be read.
      throw new KeyStoreError(
        'corrupt_store',
        'The envelope exists but its data key file is missing, so no key in it can be read.',
      );
    }
    return openEnvelope(readEnvelope(keysPath), dataKey).keys;
  }

  function save(keys: Record<string, string>): void {
    ensureDirectory();
    let dataKey = readDataKey();
    if (dataKey === null) {
      dataKey = randomBytes(DATA_KEY_BYTES);
      writeOwnerOnly(dataKeyPath, dataKey);
    }
    const plaintext: PlaintextEnvelope = { version: ENVELOPE_VERSION, keys };
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, dataKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(plaintext), 'utf8'),
      cipher.final(),
    ]);
    const envelope: EncryptedEnvelope = {
      version: ENVELOPE_VERSION,
      algorithm: ALGORITHM,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    // Written under a temporary name and renamed, so a crash part way through a
    // write cannot leave a half-written envelope that reads as a corrupt store.
    const temporaryPath = `${keysPath}.tmp`;
    writeOwnerOnly(temporaryPath, Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8'));
    renameSync(temporaryPath, keysPath);
  }

  /** Removes both files. Used when the last key goes, so no ciphertext remains. */
  function clear(): void {
    rmSync(keysPath, { force: true });
    rmSync(dataKeyPath, { force: true });
  }

  return {
    backend: 'file',

    setKey: async (provider: string, key: string): Promise<void> => {
      assertProvider(provider);
      assertKey(key);
      save({ ...load(), [provider]: key });
    },

    getKey: async (provider: string): Promise<string | null> => {
      assertProvider(provider);
      return load()[provider] ?? null;
    },

    hasKey: async (provider: string): Promise<boolean> => {
      assertProvider(provider);
      return Object.prototype.hasOwnProperty.call(load(), provider);
    },

    maskKey: async (provider: string): Promise<string> => {
      assertProvider(provider);
      return maskKeyValue(load()[provider] ?? null);
    },

    deleteKey: async (provider: string): Promise<boolean> => {
      assertProvider(provider);
      const keys = load();
      if (!Object.prototype.hasOwnProperty.call(keys, provider)) return false;
      delete keys[provider];
      if (Object.keys(keys).length === 0) {
        clear();
      } else {
        save(keys);
      }
      return true;
    },
  };
}

/**
 * The directory the file store uses when none is injected.
 *
 * `BROWSERREFLEX_KEYS_DIR` overrides it, the way `BROWSERREFLEX_DB_PATH`
 * overrides the database path. The default sits beside the database file, under
 * `~/.browserreflex`, and this function does not create it.
 */
export function getDefaultKeysDirectory(): string {
  const override = process.env.BROWSERREFLEX_KEYS_DIR;
  if (override !== undefined && override !== '') return override;
  return join(homedir(), '.browserreflex', 'keys');
}

// --------------------------------------------------------------------------
// Operating system keychain store
// --------------------------------------------------------------------------

/** The service name every keychain item is filed under. */
export const KEYCHAIN_SERVICE = 'browserreflex';

let keyringEntry: Promise<KeychainEntryFactory> | null = null;

/**
 * Loads the keychain binding once, lazily.
 *
 * The import is dynamic so that a platform with no prebuilt binding, and a
 * machine with no keychain, both reach the file store instead of failing to load
 * the server. A failed load is not cached, so a later call may try again.
 */
async function loadKeyringEntry(): Promise<KeychainEntryFactory> {
  if (keyringEntry === null) {
    keyringEntry = import('@napi-rs/keyring')
      .then((module) => {
        const entryClass: unknown = module.AsyncEntry;
        if (typeof entryClass !== 'function') {
          throw new Error('the binding loaded but exposes no AsyncEntry constructor');
        }
        const Item = entryClass as new (service: string, account: string) => KeychainEntry;
        // Called with `new` on purpose: the binding's item is a native
        // constructor, and invoking it as a plain function yields an object with
        // no methods on it.
        return (service: string, account: string): KeychainEntry => new Item(service, account);
      })
      .catch((cause: unknown) => {
        keyringEntry = null;
        throw new KeyStoreError(
          'backend_unavailable',
          `The operating system keychain binding could not be loaded: ${messageOf(cause)}`,
        );
      });
  }
  return keyringEntry;
}

export interface KeychainKeyStoreOptions {
  /** Service name to file items under. Defaults to `KEYCHAIN_SERVICE`. */
  readonly service?: string;
  /**
   * Builds the keychain item. **For tests.** Left absent in production, where the
   * operating system binding is used, so no test has to reach a real keychain to
   * cover this file.
   */
  readonly createEntry?: KeychainEntryFactory;
}

/**
 * A key store backed by the operating system keychain.
 *
 * Status: **experimental**. Verified by hand on macOS only; see the module header
 * for what that does and does not cover.
 */
export function createKeychainKeyStore(options: KeychainKeyStoreOptions = {}): KeyStore {
  const service = options.service ?? KEYCHAIN_SERVICE;

  async function entryFor(provider: string): Promise<KeychainEntry> {
    const name = assertProvider(provider);
    const create = options.createEntry ?? (await loadKeyringEntry());
    try {
      return create(service, name);
    } catch (cause) {
      throw new KeyStoreError(
        'backend_unavailable',
        `The operating system keychain rejected an item for this provider: ${messageOf(cause)}`,
      );
    }
  }

  /**
   * Runs one keychain call, so that a failure names the operation and the
   * provider and never carries the key.
   */
  async function call<T>(
    provider: string,
    operation: string,
    run: (entry: KeychainEntry) => Promise<T>,
  ): Promise<T> {
    const entry = await entryFor(provider);
    try {
      return await run(entry);
    } catch (cause) {
      if (cause instanceof KeyStoreError) throw cause;
      throw new KeyStoreError(
        'backend_unavailable',
        `The operating system keychain could not ${operation} the key for this provider: ${messageOf(cause)}`,
      );
    }
  }

  async function getKey(provider: string): Promise<string | null> {
    const stored = await call(provider, 'read', (entry) => entry.getPassword());
    // The binding reports an absent item as `null` on some platforms and as
    // `undefined` on others. Both mean the same thing here.
    return stored ?? null;
  }

  return {
    backend: 'keychain',

    setKey: async (provider: string, key: string): Promise<void> => {
      assertProvider(provider);
      assertKey(key);
      await call(provider, 'store', (entry) => entry.setPassword(key));
    },

    getKey,

    hasKey: async (provider: string): Promise<boolean> => {
      assertProvider(provider);
      return (await getKey(provider)) !== null;
    },

    maskKey: async (provider: string): Promise<string> => {
      assertProvider(provider);
      return maskKeyValue(await getKey(provider));
    },

    deleteKey: async (provider: string): Promise<boolean> => {
      assertProvider(provider);
      return call(provider, 'delete', (entry) => entry.deletePassword());
    },
  };
}

/**
 * Whether the keychain can be used at all right now.
 *
 * A load, then a read of one item under this service. A read creates nothing and
 * cannot prompt for a credential this process did not write, which is why it is
 * used rather than a write. On macOS the first use of a keychain item by an
 * unsigned command line program can raise a system dialog; that dialog belongs to
 * the platform and this module cannot suppress it.
 */
export async function isKeychainAvailable(
  createEntry?: KeychainEntryFactory,
  service: string = KEYCHAIN_SERVICE,
): Promise<boolean> {
  try {
    const create = createEntry ?? (await loadKeyringEntry());
    const entry = create(service, 'browserreflex-probe');
    await entry.getPassword();
    return true;
  } catch {
    return false;
  }
}

export interface ResolveKeyStoreOptions
  extends Partial<FileKeyStoreOptions>, KeychainKeyStoreOptions {
  /** `auto` prefers the keychain and falls back; either name is used as asked. */
  readonly backend?: KeyStoreBackend | 'auto';
}

export interface ResolvedKeyStore {
  readonly store: KeyStore;
  /** Where the returned store keeps keys. Not what was asked for, if it fell back. */
  readonly backend: KeyStoreBackend;
  /** True when `auto` returned the file store because the keychain was unusable. */
  readonly fellBack: boolean;
}

/**
 * Picks a key store.
 *
 * `auto` returns the keychain when it loads and answers a probe, and the file
 * store otherwise with `fellBack: true`. Naming a backend asks for it: a keychain
 * that will not load raises `backend_unavailable` rather than quietly handing
 * back a store other than the one requested.
 */
export async function resolveKeyStore(
  options: ResolveKeyStoreOptions = {},
): Promise<ResolvedKeyStore> {
  const requested = options.backend ?? 'auto';
  const fileOptions: FileKeyStoreOptions = {
    directory: options.directory ?? getDefaultKeysDirectory(),
    ...(options.keysFileName !== undefined ? { keysFileName: options.keysFileName } : {}),
    ...(options.dataKeyFileName !== undefined ? { dataKeyFileName: options.dataKeyFileName } : {}),
  };
  if (requested === 'file') {
    return { store: createFileKeyStore(fileOptions), backend: 'file', fellBack: false };
  }
  if (requested === 'keychain') {
    // Asked for by name, so a load failure is reported instead of being papered
    // over with a different store.
    await loadKeyringEntry();
    return { store: createKeychainKeyStore(options), backend: 'keychain', fellBack: false };
  }
  if (await isKeychainAvailable(options.createEntry, options.service ?? KEYCHAIN_SERVICE)) {
    return { store: createKeychainKeyStore(options), backend: 'keychain', fellBack: false };
  }
  return { store: createFileKeyStore(fileOptions), backend: 'file', fellBack: true };
}
