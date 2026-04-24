## ADDED Requirements

### Requirement: Executor decrypts manifest.secrets per invocation

For every `Executor.invoke(…)` call whose workflow's manifest entry contains `secrets`, the executor SHALL decrypt each base64 ciphertext into a `plaintextStore: Record<string, string>` keyed by envName before invoking the sandbox. The decryption SHALL use `decryptSealed` against the primary/retained key looked up by `manifest.secretsKeyId`.

The executor SHALL pass `plaintextStore` through to the sandbox as part of the `run` message's ctx as `ctx.plaintextStore`. After the sandbox's `run()` promise settles (success, error, or rejection), the executor SHALL zero and clear `plaintextStore` in a `finally` block before returning to the caller. Zeroing means overwriting each value with an empty string (best-effort — JS does not guarantee memory clearing beyond drop).

If the manifest entry has no `secrets` field, the executor SHALL pass `ctx.plaintextStore = {}` (empty object) or omit it entirely. The sandbox-side consumer MUST accept both shapes.

The executor SHALL NOT log plaintext values at any severity level. Errors during decrypt SHALL be logged with `envName` but without the ciphertext or plaintext.

```ts
async function invoke(trigger, input, runMeta) {
  currentRun = runMeta;
  const plaintextStore: Record<string, string> = {};
  try {
    if (manifest.secrets && manifest.secretsKeyId) {
      for (const [envName, ct] of Object.entries(manifest.secrets)) {
        const pt = decryptSealed(ct, manifest.secretsKeyId, keyStore);
        plaintextStore[envName] = new TextDecoder().decode(pt);
      }
    }
    return await sb.run(trigger, input, { ...ctx, plaintextStore });
  } finally {
    for (const k of Object.keys(plaintextStore)) plaintextStore[k] = "";
    currentRun = null;
  }
}
```

#### Scenario: Invocation with secrets populates plaintextStore

- **GIVEN** a workflow manifest with `secrets: { TOKEN: <valid-ct> }` and `secretsKeyId: <primary>`
- **WHEN** `executor.invoke(...)` is called
- **THEN** the sandbox's `run` message SHALL receive `ctx.plaintextStore = { TOKEN: <decrypted-string> }`
- **AND** the decrypted string SHALL equal the original sealed plaintext

#### Scenario: Plaintext is wiped after run

- **GIVEN** an invocation that decrypted secrets successfully
- **WHEN** the sandbox's `run()` promise settles (either resolve or reject)
- **THEN** the executor's local `plaintextStore` reference SHALL have each value overwritten with `""` before returning
- **AND** no further code path SHALL retain the plaintext

#### Scenario: Decrypt failure propagates as executor error

- **GIVEN** a manifest whose `secretsKeyId` refers to a retired key
- **WHEN** `executor.invoke(...)` is called
- **THEN** decryption SHALL throw `UnknownKeyIdError` (from the key-store helper)
- **AND** the executor SHALL resolve `InvokeResult` to `{ ok: false, error: { message: <descriptive> } }`
- **AND** the event bus SHALL see a trigger-error event with the same message

#### Scenario: Invocation without secrets is unchanged

- **GIVEN** a workflow whose manifest has no `secrets` field
- **WHEN** `executor.invoke(...)` is called
- **THEN** `ctx.plaintextStore` SHALL be `{}` or omitted
- **AND** executor behavior SHALL otherwise be identical to pre-feature behavior

#### Scenario: Concurrent invocations do not share plaintextStore

- **GIVEN** two invocations against different workflows (different sandboxes) running concurrently
- **WHEN** each decrypts its own manifest.secrets
- **THEN** each invocation's `plaintextStore` SHALL be a distinct object
- **AND** cross-invocation plaintext contamination SHALL NOT be possible
