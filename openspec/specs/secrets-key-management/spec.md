# Secrets Key Management Specification

## Purpose

Provide runtime-side cryptographic key management for workflow secrets: parsing the `SECRETS_PRIVATE_KEYS` CSV into an X25519 keypair list, serving lookup by keyId fingerprint, and supplying sealed-box decryption helpers for use by the upload handler, the executor, and any future tooling that needs to decrypt workflow-author-sealed secrets.

## Requirements

### Requirement: SECRETS_PRIVATE_KEYS env var format

The runtime SHALL accept a `SECRETS_PRIVATE_KEYS` configuration field as a comma-separated list of `keyId:base64(sk)` entries. The primary (active sealing) key SHALL be first in the list. Entries SHALL be trimmed; empty entries SHALL be rejected. Each `sk` SHALL base64-decode to exactly 32 bytes (X25519 secret key size).

```
SECRETS_PRIVATE_KEYS=a1b2c3d4e5f60718:<b64-32-bytes>,9f8e7d6c5b4a3210:<b64-32-bytes>
```

The runtime SHALL fail startup with a clear error if the variable is empty, malformed, or any `sk` decodes to the wrong length.

#### Scenario: Valid single-key config

- **GIVEN** `SECRETS_PRIVATE_KEYS` is `"a1b2c3d4e5f60718:<valid-32-byte-b64>"`
- **WHEN** `createConfig(env)` runs
- **THEN** the config SHALL parse without error
- **AND** the key-store SHALL have exactly one entry with primary = `"a1b2c3d4e5f60718"`

#### Scenario: Valid multi-key config

- **GIVEN** `SECRETS_PRIVATE_KEYS` is `"k1:<b64-32>,k2:<b64-32>"`
- **WHEN** the key-store loads
- **THEN** `getPrimary()` SHALL return the entry for `k1`
- **AND** `lookup("k1")` and `lookup("k2")` SHALL each return a valid entry

#### Scenario: Malformed entry fails startup

- **GIVEN** `SECRETS_PRIVATE_KEYS` is `"bad-no-colon"`
- **WHEN** `createConfig(env)` runs
- **THEN** the runtime SHALL fail startup with an error describing the malformed entry

#### Scenario: Empty env var fails startup

- **GIVEN** `SECRETS_PRIVATE_KEYS` is empty or missing
- **WHEN** `createConfig(env)` runs
- **THEN** the runtime SHALL fail startup with an error requiring the variable

#### Scenario: Wrong-length secret key fails startup

- **GIVEN** `SECRETS_PRIVATE_KEYS` is `"k1:<b64-of-16-bytes>"`
- **WHEN** the key-store parses
- **THEN** startup SHALL fail with an error naming the wrong length

### Requirement: Key-store API

The runtime SHALL provide a key-store module with the following API:

```ts
interface SecretsKeyStore {
  getPrimary(): { keyId: string; pk: Uint8Array; sk: Uint8Array };
  lookup(keyId: string): { pk: Uint8Array; sk: Uint8Array } | undefined;
  allKeyIds(): string[];
}
```

`pk` SHALL be derived from `sk` on demand via X25519 `crypto_scalarmult_base`. Public keys SHALL NOT be stored separately in the config or state.

`getPrimary()` SHALL always return the first entry from the parsed CSV. `lookup(keyId)` SHALL return undefined for unknown keyIds. `allKeyIds()` SHALL return the list in primary-first order.

#### Scenario: Primary returns first entry

- **GIVEN** `SECRETS_PRIVATE_KEYS` is `"k1:...,k2:..."` with valid keys
- **WHEN** `getPrimary()` is called
- **THEN** it SHALL return the entry with `keyId: "k1"`

#### Scenario: Lookup returns retained entry

- **GIVEN** `SECRETS_PRIVATE_KEYS` is `"k1:...,k2:..."`
- **WHEN** `lookup("k2")` is called
- **THEN** it SHALL return an entry with `pk` derived from k2's `sk`

#### Scenario: Lookup returns undefined for unknown keyId

- **GIVEN** a key-store loaded with `k1` only
- **WHEN** `lookup("unknown")` is called
- **THEN** it SHALL return `undefined`

#### Scenario: Public key is derived, not stored

- **GIVEN** a key-store entry loaded from CSV
- **WHEN** the entry's `pk` field is inspected
- **THEN** the bytes SHALL equal `crypto_scalarmult_base(sk)` for that entry's `sk`

### Requirement: computeKeyId helper in core

The `@workflow-engine/core` package SHALL export `computeKeyId(publicKey: Uint8Array): string` returning the lowercase hex encoding of the first 8 bytes of `sha256(publicKey)`. The package SHALL also export `SECRETS_KEY_ID_BYTES: number = 8`.

`computeKeyId` SHALL be the single source of truth for key fingerprinting. The key-store, the upload handler, the public-key endpoint, and any future CLI sealing code SHALL compute keyIds via this helper.

#### Scenario: computeKeyId returns 16-char lowercase hex

- **GIVEN** any 32-byte `publicKey`
- **WHEN** `computeKeyId(publicKey)` is called
- **THEN** the return value SHALL be a 16-character string
- **AND** SHALL match `/^[0-9a-f]{16}$/`

#### Scenario: Deterministic fingerprint

- **GIVEN** the same `publicKey` bytes
- **WHEN** `computeKeyId` is called twice
- **THEN** both return values SHALL be identical

### Requirement: Key-store plaintext decrypt helper

The runtime SHALL provide a helper that decrypts a base64-encoded sealed-box ciphertext using a looked-up keyId:

```ts
function decryptSealed(b64Ciphertext: string, keyId: string, keyStore: SecretsKeyStore): Uint8Array;
```

The helper SHALL throw a clearly-named error class `UnknownKeyIdError` when `keyId` is not resident, and `SecretDecryptError` when decryption fails (e.g., ciphertext was sealed with a different public key than the looked-up sk's derived pk).

#### Scenario: Valid ciphertext decrypts

- **GIVEN** a ciphertext sealed with `pk_k1` for plaintext `"hello"`
- **WHEN** `decryptSealed(<ct-b64>, "k1", keyStore)` is called
- **THEN** it SHALL return the bytes of `"hello"`

#### Scenario: Unknown keyId throws UnknownKeyIdError

- **WHEN** `decryptSealed(ct, "unknown", keyStore)` is called
- **THEN** it SHALL throw `UnknownKeyIdError` with the unknown id in the message

#### Scenario: Bad ciphertext throws SecretDecryptError

- **GIVEN** a ciphertext sealed with a public key whose corresponding sk is not in the store
- **WHEN** `decryptSealed(ct, "k1", keyStore)` is called with `"k1"` being a different key
- **THEN** it SHALL throw `SecretDecryptError`
