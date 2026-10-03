# Security

Redaction of secrets, advisory safety rules, and immutable audit logs.

## Redaction

`redact.ts` is **implemented and tested** as a module. It masks API keys and
tokens, passwords, card numbers, email addresses and phone numbers in a string,
and keeps a SHA-256 hash of the original input so that a decision can be
recognised on a later run while the stored text stays redacted. The test is
`packages/server/test/redact.test.ts`: fifty fixtures plus a set of awkward
shapes, each checked for leaks in any spelling, plus a measured cost check.

What is **not** done: nothing calls `redact` yet. Wiring it into the store, the
log and the exports is planned, and until that exists the claim is about the
module and not about the server. Reading the hash as protection against someone
who already holds the database is also not a claim this module makes; the limit
is recorded on the function itself.

## Key storage

`keys.ts` is **implemented and tested** as a module for the encrypted file store
and for masking. The operating system keychain backend in the same file is
**experimental**. The test is `packages/server/test/keys.test.ts`.

What the module holds, each with a named test in that file:

- A key is never written in plaintext. The file store keeps one AES-256-GCM
  ciphertext; the test reads the raw bytes of every file written and looks for the
  key in every spelling a file could plausibly carry it in, including base64 and
  hex at every alignment, and not only as the whole key but as a run of twenty of
  its characters. Base64 is not encryption, so a check for the raw spelling alone
  would not have been enough: that is what a sabotage run showed.
- The database never holds a key. The module imports nothing from the store and
  takes no database handle. The test writes real settings and a real session to a
  real database, sets keys, and checks that the `settings` table holds none, and
  that neither the database file, its write-ahead log nor its shared memory file
  contains the key.
- No response shape can carry a full key. `summarizeKey` returns a provider, a
  presence flag and a masked string, and there is no field in it a full key could
  occupy. `getKey` is documented as being for calling a provider with, never for
  showing one.
- Masking shows at most half of a key and never all of it. A key of fewer than 22
  characters is replaced by eight dots and nothing else; a longer one keeps its
  first seven and last four characters. The run of dots is a fixed length, so a
  mask does not disclose the key's length either.
- Nothing is repaired silently. An upper-case provider id, an empty key, a key
  with a control character, a key padded with whitespace and an over-long key
  are all rejected, none of them normalised.
- A store that cannot be read raises `corrupt_store`. A changed ciphertext, a
  wrong data key, a missing data key and a mangled envelope are all reported, and
  none of them is reported as an empty store, because a lost key described as a
  missing one is exactly the misdescription this project treats as its worst
  failure.

Two backends, and the choice between them:

| Backend | Claim | What it is |
|---|---|---|
| `file` | **implemented and tested** | Every key in one AES-256-GCM envelope, `keys.enc.json`, with a random 32-byte data key in `keys.dat` beside it. Both files are written `0600` in an injectable directory, `~/.browserreflex/keys` by default, overridable with `BROWSERREFLEX_KEYS_DIR`. |
| `keychain` | **experimental** | The operating system keychain, through `@napi-rs/keyring` (MIT). Each key is one item under the service name `browserreflex`. |

`resolveKeyStore({ backend: 'auto' })` prefers the keychain and falls back to the
file store when the binding will not load or cannot answer a probe, reporting
`fellBack: true` so no caller is told a keychain is in use when it is not. Naming
a backend asks for it: `backend: 'keychain'` raises `backend_unavailable` rather
than quietly returning a different store.

### What has and has not been verified about the keychain backend

Verified, by running `packages/server/src/security/keys.ts` against the real
binding on macOS on Apple silicon: a set, get, mask, summarise and delete round
trip, and `resolveKeyStore` selecting the keychain rather than falling back.

**Not** verified: Linux and Windows. Neither was run. On Linux the binding uses
the Secret Service and falls back to the kernel keyring, and on Windows it uses
Credential Manager; neither path has been exercised. The binding's own wiring
(this module's call into it) has no automated test, because such a test would
have to reach a real keychain. That wiring is the part a fake item factory
cannot cover, and it is why the backend is labelled experimental rather than
implemented and tested.

A first use of a keychain item by an unsigned command line program can raise a
system dialog on macOS. That dialog belongs to the platform; this module cannot
suppress it.

### The limit of the file store

The data key sits in a second file next to the ciphertext, both readable only by
the owner. That keeps a key out of a backup, a synced folder, a screenshot, a
crash report and any tool that reads that directory. It does **not** keep a key
from another program running as the same user, who can read both files and
decrypt. Only the operating system keychain closes that gap, which is why the
keychain is the preferred backend where it works. This limit is also recorded on
the module itself.

## Not done here

Nothing in the server calls `keys.ts` yet. There is no tool, no UI page and no
provider adapter, so no key is set or read anywhere in the running server. The
claims above are about the module and not about the server.

Advisory safety rules and the immutable audit log are **planned**. The safety
check is advisory: it never prevents an agent from acting.