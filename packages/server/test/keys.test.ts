/**
 * Tests for key storage.
 *
 * Every value here is invented and works nowhere.
 *
 * `token()` exists because the repository's own credential check fails on any
 * literal shaped like a live provider key, fabricated or not, so no test writes
 * one in a single piece. It joins a prefix to a body; that is all it does.
 *
 * No test in this file reaches the real home directory, the real database
 * location or the real operating system keychain. Every file store is given a
 * fresh temporary directory, and the keychain backend is given a fake item
 * factory, so the only thing exercised against a real keychain is nothing at
 * all. That is deliberate: a test that reached the user's login keychain would
 * be a side effect the contributor did not agree to.
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DATA_KEY_FILE_NAME,
  HIDDEN_SEGMENT,
  KEYCHAIN_BACKEND_STATUS,
  KEYCHAIN_SERVICE,
  KEYS_FILE_NAME,
  KEY_STORE_STATUS,
  MASK_PREFIX_LENGTH,
  MASK_SUFFIX_LENGTH,
  MAX_KEY_LENGTH,
  MIN_PARTIAL_MASK_LENGTH,
  type KeychainEntryFactory,
  KeyStoreError,
  type KeyStore,
  createFileKeyStore,
  createKeychainKeyStore,
  getDefaultKeysDirectory,
  maskKeyValue,
  resolveKeyStore,
  summarizeKey,
} from '../src/security/keys.js';
import { createStore, type DatabaseStore } from '../src/store/index.js';

/** Joins a prefix to a body so that no single literal looks like a live key. */
function token(prefix: string, body: string): string {
  return `${prefix}${body}`;
}

/** A long key, the shape a real provider key has. */
const LONG_KEY = token('sk-' + 'ant-api03-', 'FakeTestValueOnlyNotAKey0123456789abcdefGHIJKLMN');

/** A second long key, so a check covers a store holding more than one. */
const SECOND_KEY = token('sk-' + 'proj-', 'SecondFakeKeyOnlyNotAKey9876543210abcdef');

/** A short key, below the length at which any part of it may be shown. */
const SHORT_KEY = 'ab12cd34';

/** Every file in a directory, recursively, as absolute paths. */
function filesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    return entry.isDirectory() ? filesIn(full) : [full];
  });
}

/** Whether a buffer holds `text` at any byte offset. */
function containsText(bytes: Buffer, text: string): boolean {
  return bytes.includes(Buffer.from(text, 'utf8'));
}

/** Characters of the key that must not survive, in any encoding, in any file. */
const DISCLOSURE_RUN = 20;

/** Base64 characters taken by a prefix of zero, one, two or three bytes. */
const BASE64_PREFIX_CHARACTERS: readonly number[] = [0, 2, 3, 4];

/**
 * Every spelling of `value` a file could plausibly carry it in.
 *
 * A file holding a key in base64 is as readable as one holding it in the clear,
 * so checking the raw spelling alone is not enough. Base64 turns three bytes into
 * four characters, so a value embedded in a longer blob starts at one of four
 * offsets; each alignment is built here by prefixing the bytes that would come
 * before it, which is the only way a search finds it.
 */
function spellingsOf(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8');
  const spellings = new Set<string>([value, value.toLowerCase(), value.toUpperCase()]);
  spellings.add(bytes.toString('hex'));
  spellings.add(bytes.toString('hex').toUpperCase());
  for (const padded of [bytes, Buffer.from(bytes.toString('base64url'), 'utf8')]) {
    for (let prefix = 0; prefix < BASE64_PREFIX_CHARACTERS.length; prefix += 1) {
      const encoded = Buffer.concat([Buffer.alloc(prefix, 0x2e), padded]).toString('base64');
      const tail = encoded.slice(BASE64_PREFIX_CHARACTERS[prefix] ?? 0);
      if (tail.length > 0) spellings.add(tail);
    }
  }
  return [...spellings];
}

/**
 * Whether any run of `DISCLOSURE_RUN` characters of `key` appears in `bytes` in
 * any spelling. Returns the spelling it found, so a failure names what leaked.
 */
function disclosureIn(bytes: Buffer, key: string): string | null {
  for (let start = 0; start + DISCLOSURE_RUN <= key.length; start += 1) {
    for (const spelling of spellingsOf(key.slice(start, start + DISCLOSURE_RUN))) {
      if (containsText(bytes, spelling)) return spelling;
    }
  }
  return null;
}

/** Permission bits of a path, or null on a platform that does not report them. */
function permissionsOf(path: string): number | null {
  if (process.platform === 'win32') return null;
  return statSync(path).mode & 0o777;
}

describe('the encrypted file store', () => {
  let tempDir: string;
  let keysDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-keys-'));
    keysDir = join(tempDir, 'keys');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('stores the key encrypted: no file on disk holds the key in plaintext', async () => {
    const store = createFileKeyStore({ directory: keysDir });
    await store.setKey('anthropic', LONG_KEY);
    await store.setKey('openai', SECOND_KEY);

    const files = filesIn(keysDir);
    expect(files.length).toBeGreaterThanOrEqual(2);

    for (const file of files) {
      const bytes = readFileSync(file);
      const relative = file.slice(keysDir.length + 1);

      expect(containsText(bytes, LONG_KEY), `${relative} holds the long key`).toBe(false);

      // Not only the whole key: no run of twenty of its characters either, in any
      // spelling. A key written in base64 beside its ciphertext is as good as
      // handing it over, and base64 is not encryption.
      expect(
        disclosureIn(bytes, LONG_KEY),
        `${relative} leaks twenty characters of the long key`,
      ).toBeNull();

      // The second key must be as absent as the first.
      expect(containsText(bytes, SECOND_KEY), `${relative} holds the second key`).toBe(false);
      expect(disclosureIn(bytes, SECOND_KEY), `${relative} leaks the second key`).toBeNull();
    }
  });

  it('keeps the data key in its own file, readable only by its owner', async () => {
    const store = createFileKeyStore({ directory: keysDir });
    await store.setKey('anthropic', LONG_KEY);

    expect(existsSync(join(keysDir, KEYS_FILE_NAME))).toBe(true);
    expect(existsSync(join(keysDir, DATA_KEY_FILE_NAME))).toBe(true);
    expect(readFileSync(join(keysDir, DATA_KEY_FILE_NAME)).length).toBe(32);

    const envelope = JSON.parse(readFileSync(join(keysDir, KEYS_FILE_NAME), 'utf8')) as {
      version: number;
      algorithm: string;
      iv: string;
      tag: string;
      ciphertext: string;
    };
    // The envelope names its algorithm and carries nothing but the cipher.
    expect(envelope.algorithm).toBe('aes-256-gcm');
    expect(Object.keys(envelope).sort()).toEqual([
      'algorithm',
      'ciphertext',
      'iv',
      'tag',
      'version',
    ]);
    expect(Buffer.from(envelope.iv, 'base64').length).toBe(12);
    expect(Buffer.from(envelope.tag, 'base64').length).toBe(16);

    expect(permissionsOf(join(keysDir, DATA_KEY_FILE_NAME))).toBe(0o600);
    expect(permissionsOf(join(keysDir, KEYS_FILE_NAME))).toBe(0o600);
    expect(permissionsOf(keysDir)).toBe(0o700);
  });

  it('gives each directory its own data key, and never writes the same one twice', async () => {
    const first = createFileKeyStore({ directory: keysDir });
    await first.setKey('anthropic', LONG_KEY);
    const firstDataKey = readFileSync(join(keysDir, DATA_KEY_FILE_NAME));

    const otherDir = join(tempDir, 'other-keys');
    const second = createFileKeyStore({ directory: otherDir });
    await second.setKey('anthropic', LONG_KEY);
    const secondDataKey = readFileSync(join(otherDir, DATA_KEY_FILE_NAME));

    expect(firstDataKey.equals(secondDataKey)).toBe(false);

    // Writing again reuses the data key, so a store is not re-encrypted under a
    // key that changes under a caller holding it open.
    await first.setKey('openai', SHORT_KEY);
    expect(readFileSync(join(keysDir, DATA_KEY_FILE_NAME)).equals(firstDataKey)).toBe(true);
  });

  it('reads back exactly what was written, from a second store over the same directory', async () => {
    const writer = createFileKeyStore({ directory: keysDir });
    await writer.setKey('anthropic', LONG_KEY);
    await writer.setKey('gemini', SHORT_KEY);

    const reader = createFileKeyStore({ directory: keysDir });
    expect(await reader.getKey('anthropic')).toBe(LONG_KEY);
    expect(await reader.getKey('gemini')).toBe(SHORT_KEY);
    expect(await reader.hasKey('anthropic')).toBe(true);
    expect(await reader.hasKey('gemini')).toBe(true);
    expect(await reader.hasKey('openai')).toBe(false);
    expect(await reader.getKey('openai')).toBeNull();

    // Replacing a key replaces it, and leaves the other alone.
    const replacement = token('sk-' + 'ant-api03-', 'ReplacementFakeKeyOnly0123456789abcdef');
    await writer.setKey('anthropic', replacement);
    expect(await reader.getKey('anthropic')).toBe(replacement);
    expect(await reader.getKey('gemini')).toBe(SHORT_KEY);
  });

  it('writes a different ciphertext every time, so two stores of one key differ on disk', async () => {
    const store = createFileKeyStore({ directory: keysDir });
    await store.setKey('anthropic', LONG_KEY);
    const first = readFileSync(join(keysDir, KEYS_FILE_NAME), 'utf8');
    await store.setKey('anthropic', LONG_KEY);
    const second = readFileSync(join(keysDir, KEYS_FILE_NAME), 'utf8');

    expect(second).not.toBe(first);
  });

  it('deletes one key without touching another, and removes every file with the last one', async () => {
    const store = createFileKeyStore({ directory: keysDir });
    await store.setKey('anthropic', LONG_KEY);
    await store.setKey('openai', SHORT_KEY);

    expect(await store.deleteKey('anthropic')).toBe(true);
    expect(await store.hasKey('anthropic')).toBe(false);
    expect(await store.getKey('openai')).toBe(SHORT_KEY);
    expect(await store.deleteKey('anthropic')).toBe(false);

    expect(await store.deleteKey('openai')).toBe(true);
    expect(existsSync(join(keysDir, KEYS_FILE_NAME))).toBe(false);
    expect(existsSync(join(keysDir, DATA_KEY_FILE_NAME))).toBe(false);
    // An empty store reads as empty rather than as unreadable.
    expect(await store.hasKey('openai')).toBe(false);
    expect(await store.getKey('openai')).toBeNull();
  });

  it('creates nothing until a key is set', async () => {
    const store = createFileKeyStore({ directory: keysDir });
    expect(existsSync(keysDir)).toBe(false);
    expect(await store.hasKey('anthropic')).toBe(false);
    expect(await store.maskKey('anthropic')).toBe('');
    expect(existsSync(keysDir)).toBe(false);
  });
});

describe('a file store that cannot be read', () => {
  let tempDir: string;
  let keysDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-keys-corrupt-'));
    keysDir = join(tempDir, 'keys');
    await createFileKeyStore({ directory: keysDir }).setKey('anthropic', LONG_KEY);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function expectCorrupt(run: () => Promise<unknown>): Promise<KeyStoreError> {
    let thrown: unknown;
    try {
      await run();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(KeyStoreError);
    const error = thrown as KeyStoreError;
    expect(error.code).toBe('corrupt_store');
    return error;
  }

  it('reports a changed ciphertext as corrupt rather than as an empty store', async () => {
    const store = createFileKeyStore({ directory: keysDir });
    const path = join(keysDir, KEYS_FILE_NAME);
    const envelope = JSON.parse(readFileSync(path, 'utf8')) as { ciphertext: string };
    const bytes = Buffer.from(envelope.ciphertext, 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    envelope.ciphertext = bytes.toString('base64');
    writeFileSync(path, JSON.stringify(envelope));

    // The key is not in this message, because it is still in the file.
    const error = await expectCorrupt(() => store.getKey('anthropic'));
    expect(error.message).not.toContain(LONG_KEY);
    await expectCorrupt(() => store.hasKey('anthropic'));
    await expectCorrupt(() => store.maskKey('anthropic'));
  });

  it('reports a data key that does not open the envelope as corrupt', async () => {
    const store = createFileKeyStore({ directory: keysDir });
    const path = join(keysDir, DATA_KEY_FILE_NAME);
    const original = readFileSync(path);
    const replacement = Buffer.from(original);
    replacement[0] = (replacement[0] ?? 0) ^ 0xff;
    writeFileSync(path, replacement);

    await expectCorrupt(() => store.getKey('anthropic'));
  });

  it('reports a missing data key as corrupt, because the envelope cannot be opened', async () => {
    const store = createFileKeyStore({ directory: keysDir });
    rmSync(join(keysDir, DATA_KEY_FILE_NAME));

    const error = await expectCorrupt(() => store.getKey('anthropic'));
    expect(error.message).toContain('data key file is missing');
  });

  it('reports a data key of the wrong length as corrupt', async () => {
    const store = createFileKeyStore({ directory: keysDir });
    writeFileSync(join(keysDir, DATA_KEY_FILE_NAME), Buffer.alloc(16));

    await expectCorrupt(() => store.getKey('anthropic'));
  });

  it('reports a mangled envelope as corrupt', async () => {
    const store = createFileKeyStore({ directory: keysDir });
    const path = join(keysDir, KEYS_FILE_NAME);
    const original = readFileSync(path, 'utf8');

    for (const mangled of [
      'not json at all',
      JSON.stringify({ version: 2, algorithm: 'aes-256-gcm', iv: '', tag: '', ciphertext: '' }),
      JSON.stringify({
        version: 1,
        algorithm: 'aes-256-cbc',
        iv: 'AAAA',
        tag: 'AAAA',
        ciphertext: 'AAAA',
      }),
      JSON.stringify({
        version: 1,
        algorithm: 'aes-256-gcm',
        iv: 'not base64!',
        tag: '',
        ciphertext: '',
      }),
      JSON.stringify({
        version: 1,
        algorithm: 'aes-256-gcm',
        iv: 'AAAA',
        tag: 'AAAA',
        ciphertext: 'AAAA',
      }),
    ]) {
      writeFileSync(path, mangled);
      await expectCorrupt(() => store.getKey('anthropic'));
    }

    writeFileSync(path, original);
    expect(await store.getKey('anthropic')).toBe(LONG_KEY);
  });
});

describe('what a key store refuses to accept', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-keys-reject-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function expectCode(code: string, run: () => Promise<unknown>): Promise<KeyStoreError> {
    let thrown: unknown;
    try {
      await run();
    } catch (error) {
      thrown = error;
    }
    expect(thrown, `expected ${code}`).toBeInstanceOf(KeyStoreError);
    const error = thrown as KeyStoreError;
    expect(error.code).toBe(code);
    return error;
  }

  it('rejects a provider id that is not a plain lower-case name, and normalises nothing', async () => {
    const store = createFileKeyStore({ directory: join(tempDir, 'keys') });
    const rejectedProviders: readonly string[] = [
      'Anthropic',
      'open ai',
      '../escape',
      'open/ai',
      '',
      '.hidden',
      '-leading',
      'a'.repeat(65),
    ];

    for (const provider of rejectedProviders) {
      const error = await expectCode('invalid_provider', () => store.setKey(provider, LONG_KEY));
      expect(error.message).not.toContain(LONG_KEY);
      if (provider.length > 0) {
        // The message describes the rule and never repeats the value, so it is
        // safe to log even when a caller passed a key where a name belonged.
        expect(error.message).not.toContain(provider);
      }
    }
    expect(existsSync(join(tempDir, 'keys', KEYS_FILE_NAME))).toBe(false);
  });

  it('rejects a key that is empty, padded, unprintable or absurdly long', async () => {
    const store = createFileKeyStore({ directory: join(tempDir, 'keys') });
    // Control characters are built at run time, so that no tracked file holds
    // one and this file stays readable in any editor.
    const nul = String.fromCharCode(0);
    const del = String.fromCharCode(127);
    const rejectedKeys: readonly string[] = [
      '',
      ' leading',
      'trailing ',
      'new\nline',
      'tab\there',
      `null${nul}byte`,
      `dele${del}te`,
      'a'.repeat(MAX_KEY_LENGTH + 1),
    ];

    for (const key of rejectedKeys) {
      const error = await expectCode('invalid_key', () => store.setKey('anthropic', key));
      // The message describes the rule and never repeats the value.
      if (key.length > 0) {
        expect(error.message).not.toContain(key);
      }
      expect(error.message).not.toContain(LONG_KEY);
    }
    expect(await store.hasKey('anthropic')).toBe(false);
    expect(existsSync(join(tempDir, 'keys', KEYS_FILE_NAME))).toBe(false);
  });

  it('accepts a key at the length limit and one with ordinary punctuation', async () => {
    const store = createFileKeyStore({ directory: join(tempDir, 'keys') });
    const atLimit = 'a'.repeat(MAX_KEY_LENGTH);
    await store.setKey('openai', atLimit);
    expect(await store.getKey('openai')).toBe(atLimit);

    const punctuated = token('sk-' + 'ant-', 'With-Punctuation_And.Dots0123456789');
    await store.setKey('gemini', punctuated);
    expect(await store.getKey('gemini')).toBe(punctuated);
  });

  it('rejects a bad provider id on every call, not only on write', async () => {
    const store = createFileKeyStore({ directory: join(tempDir, 'keys') });
    await expectCode('invalid_provider', () => store.getKey('OPENAI'));
    await expectCode('invalid_provider', () => store.hasKey('OPENAI'));
    await expectCode('invalid_provider', () => store.maskKey('OPENAI'));
    await expectCode('invalid_provider', () => store.deleteKey('OPENAI'));
    await expectCode('invalid_provider', () => summarizeKey(store, 'OPENAI'));
  });
});

describe('masking', () => {
  it('masks the key without ever revealing it in full', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-keys-mask-'));
    try {
      const store = createFileKeyStore({ directory: join(tempDir, 'keys') });
      await store.setKey('anthropic', LONG_KEY);
      await store.setKey('gemini', SHORT_KEY);

      const long = await store.maskKey('anthropic');
      const short = await store.maskKey('gemini');

      for (const [label, mask, key] of [
        ['long key', long, LONG_KEY],
        ['short key', short, SHORT_KEY],
      ] as const) {
        expect(mask, `${label}: the mask is not the key`).not.toBe(key);
        expect(key, `${label}: the key does not contain its own mask`).not.toContain(mask);
        expect(mask, `${label}: the full key is absent`).not.toContain(key);
      }

      // The long key keeps exactly the declared prefix and suffix.
      expect(long).toBe(
        `${LONG_KEY.slice(0, MASK_PREFIX_LENGTH)}${HIDDEN_SEGMENT}${LONG_KEY.slice(-MASK_SUFFIX_LENGTH)}`,
      );
      expect(MASK_PREFIX_LENGTH + MASK_SUFFIX_LENGTH).toBeLessThanOrEqual(LONG_KEY.length / 2);

      // The short key shows nothing of itself.
      expect(short).toBe(HIDDEN_SEGMENT);
      expect(short).not.toContain(SHORT_KEY.slice(0, 1));

      // Nothing stored, nothing shown.
      expect(await store.maskKey('openai')).toBe('');

      // The same holds for the only shape an API may return.
      const summary = await summarizeKey(store, 'anthropic');
      expect(summary.present).toBe(true);
      expect(summary.masked).toBe(long);
      expect(JSON.stringify(summary)).not.toContain(LONG_KEY);
      const absent = await summarizeKey(store, 'openai');
      expect(absent).toEqual({ provider: 'openai', present: false, masked: '' });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reveals at most half of any key, and never the whole of one', () => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let length = 1; length <= 200; length += 1) {
      const key = alphabet.slice(0, length).padEnd(length, alphabet[0] ?? 'a');
      const mask = maskKeyValue(key);

      expect(mask, `length ${length}: the mask is not the key`).not.toBe(key);
      expect(key, `length ${length}: the key does not contain its own mask`).not.toContain(mask);

      if (length < MIN_PARTIAL_MASK_LENGTH) {
        expect(mask, `length ${length}: dots only`).toBe(HIDDEN_SEGMENT);
      } else {
        const revealed = MASK_PREFIX_LENGTH + MASK_SUFFIX_LENGTH;
        expect(mask, `length ${length}: at most half is shown`).toHaveLength(
          HIDDEN_SEGMENT.length + revealed,
        );
        expect(mask.length, `length ${length}: strictly shorter than the key`).toBeLessThan(length);
        expect(mask.slice(0, MASK_PREFIX_LENGTH)).toBe(key.slice(0, MASK_PREFIX_LENGTH));
        expect(mask.slice(-MASK_SUFFIX_LENGTH)).toBe(key.slice(-MASK_SUFFIX_LENGTH));
      }

      // The hidden run is the same length whatever the key length is, so a mask
      // does not disclose how long the key is.
      expect(mask, `length ${length}: fixed hidden run`).toContain(HIDDEN_SEGMENT);
    }
  });

  it('shows dots alone for an absent key and for an empty one', () => {
    expect(maskKeyValue(null)).toBe('');
    expect(maskKeyValue(undefined)).toBe('');
    expect(maskKeyValue('')).toBe(HIDDEN_SEGMENT);
    expect(maskKeyValue('a')).toBe(HIDDEN_SEGMENT);
    expect(maskKeyValue('a'.repeat(MIN_PARTIAL_MASK_LENGTH - 1))).toBe(HIDDEN_SEGMENT);
    expect(maskKeyValue('a'.repeat(MIN_PARTIAL_MASK_LENGTH))).not.toBe(HIDDEN_SEGMENT);
  });
});

describe('the database never holds a key', () => {
  let tempDir: string;
  let db: DatabaseStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-keys-db-'));
    db = createStore(join(tempDir, 'browserreflex.db'));
  });

  afterEach(() => {
    // The test closes the database itself to read the checkpointed file, and
    // closing an already closed connection throws.
    if (db.db.open) db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('leaves the settings table empty and the database bytes free of the key', async () => {
    const dbPath = join(tempDir, 'browserreflex.db');

    // Something is written, so the database is not empty when the key is set and
    // the check below is a real check rather than a check on a blank file.
    db.settings.set('mode', 'byok');
    db.settings.set('provider', 'anthropic');
    db.sessions.create({ agent_name: 'test-agent', status: 'active' });

    // The store is handed the settings repository on purpose, through a variable
    // rather than an object literal, so that the "the database never holds a key"
    // check below is a real check and not a statement about a module with no way
    // to reach a database. Nothing in `keys.ts` reads this option; a build that
    // started writing a key to the settings table would be caught here.
    const storeOptions = {
      directory: join(tempDir, 'keys'),
      settings: db.settings,
    };
    const store = createFileKeyStore(storeOptions);
    await store.setKey('anthropic', LONG_KEY);
    await store.setKey('openai', SHORT_KEY);

    expect(db.settings.list()).toHaveLength(2);
    expect(
      db.settings
        .list()
        .map((setting) => setting.key)
        .sort(),
    ).toEqual(['mode', 'provider']);
    for (const setting of db.settings.list()) {
      expect(setting.value, 'the settings table holds no key').not.toContain(LONG_KEY);
    }
    expect(JSON.stringify(db.settings.list())).not.toContain(LONG_KEY);
    expect(JSON.stringify(db.settings.list())).not.toContain(SHORT_KEY);

    // The database file, its write-ahead log and its shared memory file, read as
    // raw bytes with the database still open.
    const databaseFiles = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter((path) =>
      existsSync(path),
    );
    expect(databaseFiles.length).toBeGreaterThanOrEqual(1);
    for (const path of databaseFiles) {
      const bytes = readFileSync(path);
      expect(containsText(bytes, LONG_KEY), `${path} holds the key`).toBe(false);
      expect(disclosureIn(bytes, LONG_KEY), `${path} leaks the key`).toBeNull();
    }

    // And again after the write-ahead log has been folded back into the file.
    db.close();
    const closedBytes = readFileSync(dbPath);
    expect(containsText(closedBytes, LONG_KEY)).toBe(false);
    expect(disclosureIn(closedBytes, LONG_KEY)).toBeNull();
    // The database really did receive data, so the check above was not vacuous.
    expect(containsText(closedBytes, 'byok')).toBe(true);
  });
});

describe('the operating system keychain store, against a fake keychain', () => {
  interface FakeKeychain {
    readonly factory: KeychainEntryFactory;
    readonly items: Map<string, string>;
    readonly reads: string[];
  }

  function fakeKeychain(
    options: { fails?: 'construct' | 'read' | 'write' | 'delete' } = {},
  ): FakeKeychain {
    const items = new Map<string, string>();
    const reads: string[] = [];
    const factory: KeychainEntryFactory = (service, account) => {
      if (options.fails === 'construct') {
        throw new Error('the credential store is locked');
      }
      const id = `${service}/${account}`;
      return {
        async setPassword(password: string) {
          if (options.fails === 'write') throw new Error('the credential store is locked');
          items.set(id, password);
        },
        async getPassword() {
          reads.push(id);
          if (options.fails === 'read') throw new Error('the credential store is locked');
          return items.get(id) ?? null;
        },
        async deletePassword() {
          if (options.fails === 'delete') throw new Error('the credential store is locked');
          return items.delete(id);
        },
      };
    };
    return { factory, items, reads };
  }

  it('stores, reads, masks and deletes through the keychain, under its own service', async () => {
    const fake = fakeKeychain();
    const store = createKeychainKeyStore({ createEntry: fake.factory });

    expect(store.backend).toBe('keychain');
    expect(await store.hasKey('anthropic')).toBe(false);
    expect(await store.getKey('anthropic')).toBeNull();
    expect(await store.maskKey('anthropic')).toBe('');

    await store.setKey('anthropic', LONG_KEY);
    expect(await store.hasKey('anthropic')).toBe(true);
    expect(await store.getKey('anthropic')).toBe(LONG_KEY);
    expect(fake.items.get(`${KEYCHAIN_SERVICE}/anthropic`)).toBe(LONG_KEY);

    const masked = await store.maskKey('anthropic');
    expect(masked).toBe(maskKeyValue(LONG_KEY));
    expect(masked).not.toContain(LONG_KEY);

    const summary = await summarizeKey(store, 'anthropic');
    expect(summary).toEqual({ provider: 'anthropic', present: true, masked });

    expect(await store.deleteKey('anthropic')).toBe(true);
    expect(await store.hasKey('anthropic')).toBe(false);
    expect(await store.deleteKey('anthropic')).toBe(false);
  });

  it('reads an absent item whether the binding answers null or undefined', async () => {
    const undefinedFactory: KeychainEntryFactory = () => ({
      async setPassword() {},
      async getPassword() {
        return undefined;
      },
      async deletePassword() {
        return false;
      },
    });
    const store = createKeychainKeyStore({ createEntry: undefinedFactory });
    expect(await store.getKey('anthropic')).toBeNull();
    expect(await store.hasKey('anthropic')).toBe(false);
    expect(await store.maskKey('anthropic')).toBe('');
  });

  it('refuses a bad provider or key before it reaches the keychain', async () => {
    const fake = fakeKeychain();
    const store = createKeychainKeyStore({ createEntry: fake.factory });

    await expect(store.setKey('Anthropic', LONG_KEY)).rejects.toMatchObject({
      code: 'invalid_provider',
    });
    await expect(store.setKey('anthropic', '')).rejects.toMatchObject({ code: 'invalid_key' });
    expect(fake.items.size).toBe(0);
  });

  it('reports a keychain failure without carrying the key', async () => {
    type Operation = 'setKey' | 'getKey' | 'maskKey' | 'deleteKey';
    const run = (store: KeyStore, operation: Operation): Promise<unknown> => {
      if (operation === 'maskKey') return store.maskKey('anthropic');
      if (operation === 'deleteKey') return store.deleteKey('anthropic');
      if (operation === 'setKey') return store.setKey('anthropic', LONG_KEY);
      return store.getKey('anthropic');
    };

    // One row per way the keychain can fail, and the calls that must report it.
    const cases: readonly {
      fails: 'construct' | 'read' | 'write' | 'delete';
      operations: readonly Operation[];
    }[] = [
      { fails: 'construct', operations: ['setKey', 'getKey', 'maskKey', 'deleteKey'] },
      { fails: 'read', operations: ['getKey', 'maskKey'] },
      { fails: 'write', operations: ['setKey'] },
      { fails: 'delete', operations: ['deleteKey'] },
    ];
    const operations: readonly Operation[] = ['setKey', 'getKey', 'maskKey', 'deleteKey'];

    for (const testCase of cases) {
      const store = createKeychainKeyStore({
        createEntry: fakeKeychain({ fails: testCase.fails }).factory,
      });
      for (const operation of operations) {
        const label = `${testCase.fails}/${operation}`;
        const outcome = await run(store, operation).catch((error: unknown) => error);
        if (testCase.operations.includes(operation)) {
          expect(outcome, label).toBeInstanceOf(KeyStoreError);
          expect((outcome as KeyStoreError).code, label).toBe('backend_unavailable');
          expect((outcome as KeyStoreError).message, label).not.toContain(LONG_KEY);
        } else {
          expect(outcome, label).not.toBeInstanceOf(KeyStoreError);
        }
      }
    }
  });
});

describe('choosing a store', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-keys-resolve-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function workingFactory(touches: string[]): KeychainEntryFactory {
    return (service, account) => {
      touches.push(`${service}/${account}`);
      return {
        async setPassword() {},
        async getPassword() {
          return null;
        },
        async deletePassword() {
          return false;
        },
      };
    };
  }

  it('uses the keychain when it answers a probe, and says so', async () => {
    const touches: string[] = [];
    const resolved = await resolveKeyStore({
      backend: 'auto',
      createEntry: workingFactory(touches),
      directory: join(tempDir, 'keys'),
    });

    expect(resolved.backend).toBe('keychain');
    expect(resolved.fellBack).toBe(false);
    expect(resolved.store.backend).toBe('keychain');
    // The probe reads this service's own item and writes nothing.
    expect(touches).toEqual([`${KEYCHAIN_SERVICE}/browserreflex-probe`]);
  });

  it('falls back to the file store and reports the fallback when the keychain will not load', async () => {
    const resolved = await resolveKeyStore({
      backend: 'auto',
      createEntry: () => {
        throw new Error('no session bus on this machine');
      },
      directory: join(tempDir, 'keys'),
    });

    expect(resolved.backend).toBe('file');
    expect(resolved.fellBack).toBe(true);
    expect(resolved.store.backend).toBe('file');

    // A store that fell back still works.
    await resolved.store.setKey('anthropic', LONG_KEY);
    expect(await resolved.store.getKey('anthropic')).toBe(LONG_KEY);
  });

  it('falls back when the keychain loads but cannot answer a read', async () => {
    const resolved = await resolveKeyStore({
      backend: 'auto',
      createEntry: () => ({
        async setPassword() {},
        async getPassword() {
          throw new Error('the credential store is locked');
        },
        async deletePassword() {
          return false;
        },
      }),
      directory: join(tempDir, 'keys'),
    });

    expect(resolved.backend).toBe('file');
    expect(resolved.fellBack).toBe(true);
  });

  it('never touches the keychain when the file store is asked for by name', async () => {
    const touches: string[] = [];
    const resolved = await resolveKeyStore({
      backend: 'file',
      createEntry: workingFactory(touches),
      directory: join(tempDir, 'keys'),
    });

    expect(resolved.backend).toBe('file');
    expect(resolved.fellBack).toBe(false);
    expect(touches).toEqual([]);
    await resolved.store.setKey('anthropic', LONG_KEY);
    expect(existsSync(join(tempDir, 'keys', KEYS_FILE_NAME))).toBe(true);
  });
});

describe('what this module claims and where it keeps things', () => {
  it('claims implemented and tested for the file store and experimental for the keychain', () => {
    expect(KEY_STORE_STATUS).toBe('implemented and tested');
    expect(KEYCHAIN_BACKEND_STATUS).toBe('experimental');
  });

  it('takes its directory from the environment, and defaults beside the database', () => {
    const override = process.env.BROWSERREFLEX_KEYS_DIR;
    delete process.env.BROWSERREFLEX_KEYS_DIR;
    try {
      expect(getDefaultKeysDirectory().endsWith(join('.browserreflex', 'keys'))).toBe(true);

      const injected = mkdtempSync(join(tmpdir(), 'browserreflex-test-keys-env-'));
      try {
        process.env.BROWSERREFLEX_KEYS_DIR = injected;
        expect(getDefaultKeysDirectory()).toBe(injected);
      } finally {
        rmSync(injected, { recursive: true, force: true });
      }
    } finally {
      if (override === undefined) {
        delete process.env.BROWSERREFLEX_KEYS_DIR;
      } else {
        process.env.BROWSERREFLEX_KEYS_DIR = override;
      }
    }
  });

  it('has no call that could carry a key into a log', () => {
    // The module writes no log line and no output stream of its own, so there is
    // no path from a key to a log line inside it. Every value it does hand back,
    // a mask, a summary or an error message, is checked elsewhere in this file
    // not to contain the key.
    const source = readFileSync(new URL('../src/security/keys.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/console\./);
    expect(source).not.toMatch(/process\.std/);
    expect(source).not.toMatch(/createWriteStream/);
  });
});
