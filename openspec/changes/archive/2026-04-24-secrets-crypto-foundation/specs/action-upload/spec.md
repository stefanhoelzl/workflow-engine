## ADDED Requirements

### Requirement: Upload handler decrypt-verifies manifest.secrets

On each workflow upload, for every workflow whose manifest entry contains a `secrets` field, the upload handler SHALL decrypt-verify each ciphertext before accepting the bundle. For each `(envName, base64Ciphertext)` entry in `manifest.secrets`:

1. Look up the secret key via `keyStore.lookup(manifest.secretsKeyId)`.
2. If the lookup returns undefined, respond 400 with `{ error: "unknown_secret_key_id", tenant, workflow: <name>, keyId: <manifest.secretsKeyId> }`.
3. Attempt `crypto_box_seal_open(base64.decode(ciphertext), pk, sk)`.
4. If decryption fails (returns null), respond 400 with `{ error: "secret_decrypt_failed", tenant, workflow: <name>, envName }`.

The handler SHALL NOT persist the plaintext; decryption results are discarded after verification. The handler SHALL NOT write the bundle to storage or register it until all secrets across all workflows in the upload have been verified.

Errors SHALL be reported for the first failing secret encountered; the handler MAY short-circuit on first failure.

#### Scenario: Upload with valid secrets succeeds

- **GIVEN** a manifest with `secrets: {TOKEN: <valid-ciphertext-for-primary-pk>}` and `secretsKeyId: <primary-keyId>`
- **WHEN** the upload is submitted
- **THEN** decrypt-verify SHALL succeed
- **AND** the upload SHALL proceed to the normal registration path
- **AND** the response SHALL be 204

#### Scenario: Upload with unknown keyId is rejected

- **GIVEN** a manifest with `secretsKeyId: "unknownkeyid12345"` (not in the runtime's keystore)
- **WHEN** the upload is submitted
- **THEN** the response SHALL be 400
- **AND** the body SHALL be `{ "error": "unknown_secret_key_id", "tenant": <t>, "workflow": <name>, "keyId": "unknownkeyid12345" }`

#### Scenario: Upload with corrupted ciphertext is rejected

- **GIVEN** a manifest with `secrets: {TOKEN: <invalid-b64-or-bad-ciphertext>}` and a valid `secretsKeyId`
- **WHEN** the upload is submitted
- **THEN** the response SHALL be 400
- **AND** the body SHALL be `{ "error": "secret_decrypt_failed", "tenant": <t>, "workflow": <name>, "envName": "TOKEN" }`

#### Scenario: Upload with ciphertext sealed by a different (non-resident) public key is rejected

- **GIVEN** a manifest with a ciphertext sealed by an X25519 public key whose corresponding sk is not in the keystore, and `secretsKeyId` pointing to a resident key (mismatch)
- **WHEN** the upload is submitted
- **THEN** the response SHALL be 400 with `secret_decrypt_failed`

#### Scenario: Upload without secrets is unaffected

- **GIVEN** a manifest without `secrets` or `secretsKeyId`
- **WHEN** the upload is submitted
- **THEN** the decrypt-verify pass SHALL be skipped
- **AND** the upload proceeds per existing behavior

#### Scenario: Upload with secrets but missing secretsKeyId is rejected at manifest validation

- **GIVEN** a manifest with `secrets: {...}` but no `secretsKeyId`
- **WHEN** the upload is submitted
- **THEN** the response SHALL be 422 at the existing ManifestSchema validation pass (before decrypt-verify runs)

#### Scenario: Plaintext is not persisted

- **GIVEN** a successful decrypt-verify pass
- **WHEN** the handler completes
- **THEN** no file on disk, state key, or log entry SHALL contain the plaintext bytes
- **AND** the decrypted bytes SHALL be zero-cleared or dropped out of scope before handler return
