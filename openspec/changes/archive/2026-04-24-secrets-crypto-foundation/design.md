## Context

The workflow-secrets feature will let tenants declare `env({ name, secret: true })` bindings whose values are sealed with a server public key at upload and decrypted per-invocation by the runtime. That feature requires:

1. A long-lived server X25519 keypair per environment, generated and stored outside the container.
2. A mechanism for the app pod to receive the private key(s) securely.
3. A public-key endpoint the CLI can call at upload time.
4. A server-side crypto path that can encrypt/decrypt using libsodium's sealed-box primitive (`crypto_box_seal` / `crypto_box_seal_open`).
5. Schema fields on the manifest carrying ciphertexts and the fingerprint of the sealing key.
6. Executor logic that decrypts per-invocation and hands plaintexts to the sandbox.

None of this is author-facing. Landing the foundation separately lets the infrastructure migration (new Tofu resources, new K8s Secret) ship under its own operational review and be verified in production before any tenant is affected.

The prod server keypair belongs in `envs/persistence/` (survives cluster rebuilds) because the ciphertexts in uploaded bundles are only decryptable with the matching private key. If the key dies on a cluster rebuild, every prod tenant would need to re-upload everything — an outage we can avoid by pinning the key's blast radius to the same scope as the prod S3 bucket. Staging and local use rebuildable in-project keypairs because their bundles are re-built on every deploy anyway.

## Goals / Non-Goals

**Goals:**
- Provision per-environment X25519 keypair lists, deliver primary-first CSV to app pods, derive public keys on demand.
- Stand up the public-key endpoint behind existing tenant auth so the future CLI can call it.
- Accept uploads with sealed secret fields and decrypt-verify each at upload time for fail-fast validation.
- Per-invocation decrypt into a plaintext store routed to the sandbox via `run` context, wiped after invocation.
- Make `computeKeyId` a core-package primitive shared by all consumers.
- Support non-breaking key rotation via multi-key CSV (primary + retained).

**Non-Goals:**
- No author SDK changes. No `env({secret:true})`. No `secret()` factory. No Vite plugin routing. No CLI changes. All land in workflow-secrets.
- No sandbox plugin for consuming `plaintextStore`. The ctx field is routed through but no plugin reads it.
- No scrubber. No `onPost` consumer. (The `onPost` hook itself is added in the sibling workflow-env-runtime-injection change.)
- No HSM, no KMS, no external key service. Private key material lives in Tofu state (encrypted at rest via `TF_VAR_STATE_PASSPHRASE`) and the K8s Secret.
- No key rotation automation. Rotation is an operator-driven `tofu apply` + redeploy cycle.
- No authentication change on the public-key endpoint beyond existing `requireTenantMember`.

## Decisions

### Decision 1: X25519 + libsodium `crypto_box_seal`

Sealing ciphertexts with a single long-lived X25519 public key plus libsodium's sealed-box primitive gives us the "fresh ciphertext per upload" property (via the ephemeral sender keypair inside `crypto_box_seal`) without requiring per-upload-key derivation schemes.

**Alternatives considered:**
- Hierarchical deterministic (BIP32-over-X25519) per-upload child public keys. Rejected — complex, minimal real security gain, narrow ecosystem support.
- RSA-OAEP. Rejected — larger ciphertexts, no native Node crypto support for raw sealed-box equivalent, more implementation risk than libsodium's widely-used primitive.
- Symmetric-only encryption with a PSK. Rejected — requires the CLI to hold the decryption key, which defeats the "bundle at rest is ciphertext the operator can't decrypt" property.

**Library choice:** `libsodium-wrappers` (existing Node ecosystem, used by Age, Mozilla Autopush, GitHub secret-sharing API reference implementations). If bundle size is a concern for the SDK CLI later, `@noble/curves` + `@noble/ciphers` is an acceptable pure-JS alternative; the runtime side uses libsodium regardless. Library choice is confirmed during implementation based on tree-shaking and install-size measurements.

### Decision 2: Multi-key CSV format `keyId:base64(sk),keyId:base64(sk),...`

`SECRETS_PRIVATE_KEYS` is a comma-separated list of `keyId:base64sk` entries with the primary (active sealing) key first. The key-store parses the CSV once at startup, builds a `Map<keyId, {pk, sk}>`, and exposes `getPrimary()` + `lookup(keyId)`.

This supports rotation without a cutover: prepend a new entry, redeploy, and existing bundles still decrypt via retained entries while new uploads seal against the new primary.

**Alternatives considered:**
- JSON env var. Rejected — extra parsing surface, no compelling benefit over simple CSV for this shape.
- Named env vars (`SECRETS_PRIMARY_KEY`, `SECRETS_RETAINED_KEY_1`, ...). Rejected — variable count complicates Tofu/K8s wiring; CSV keeps it to one env var.
- Separate file mounted via K8s Secret. Rejected — more moving parts; env var is simpler and consistent with the project's other secret-config handling.

### Decision 3: `keyId = sha256(publicKey).slice(0, 8)` hex

Sixteen lowercase hex characters. Flat format, no separators, no prefix, no version. Collision probability at our scale (≤ ~10 keys across the system's lifetime) is negligible at 64 bits.

Placed in `@workflow-engine/core` as `computeKeyId(publicKey: Uint8Array): string` + `SECRETS_KEY_ID_BYTES: number = 8`, so every consumer derives it identically.

**Alternatives considered:** See the earlier design discussion — SSH-style colon groups, base58/62, semantic prefix. All rejected for adding complexity without buying anything.

### Decision 4: Public-key endpoint inherits `requireTenantMember`

The route lives at `GET /api/workflows/:tenant/public-key`. Public keys are public by definition, but scoping the endpoint under `/api/workflows/:tenant/` keeps auth consistent with the rest of the upload-adjacent API and enforces tenant existence as a side-effect. The response is the same for every tenant (there is one server keypair), but the path is tenant-scoped for URL consistency.

**Alternatives considered:** Unauthenticated `GET /api/public-key`. Rejected for consistency with neighboring routes.

### Decision 5: Upload handler decrypts-verifies at upload

For every workflow whose manifest declares `secrets`, the upload handler looks up the sk by `secretsKeyId` and attempts `crypto_box_seal_open` on each ciphertext. Failures return 400 with specific error codes (`unknown_secret_key_id`, `secret_decrypt_failed`) so CLI/authors can diagnose quickly.

**Why eagerly verify?** Bundles with bad ciphertext would otherwise only fail at invocation time, far from the upload that caused them. Eager verification is cheap (~50µs per secret) and failure-localized.

### Decision 6: Executor per-invocation decrypt, cleared in `finally`

`plaintextStore` is built per invocation, passed to `sb.run(exportName, input, {... plaintextStore})`, and wiped by `plaintextStore = {}` (JS zeroing is best-effort; accepted) in `finally`. No plugin reads it yet. The ctx field exists solely so workflow-secrets can wire in its consumer without re-opening executor internals.

**Alternatives considered:**
- Decrypt once at sandbox construction and hold plaintexts for the sandbox's lifetime. Rejected — plaintexts should live only during active runs.
- Decrypt lazily per `.reveal()` call. Rejected — requires a completely different plugin architecture; overengineered for the data rate.

### Decision 7: Prod keypair lives in `envs/persistence/`

The persistence project already exists to hold state that must outlive cluster rebuilds (prod S3 bucket). The secrets private key fits that scope exactly — losing it would invalidate every prod tenant's bundle ciphertexts. `envs/prod/` reads via `terraform_remote_state`, creates the K8s Secret in the prod namespace (since persistence has no Kubernetes provider).

Staging and local are per-project because their bundles are re-built on every deploy; losing a staging key is recoverable via CI redeploy.

### Decision 8: K8s Secret path via existing `env_from` pattern

`modules/app-instance/workloads.tf` adds one `env_from.secret_ref { name = "app-secrets-key" }` block. The secret has a single key `SECRETS_PRIVATE_KEYS` mapped 1:1 to an env var inside the container. This matches how `app-s3-credentials` and `app-github-oauth` are already wired.

## Risks / Trade-offs

- **[Risk] Losing prod `SECRETS_PRIVATE_KEYS` leaves all tenant bundles undecryptable.** → Mitigation: keys live in `envs/persistence/` (survives cluster destroy) and Tofu state is encrypted at rest. Disaster recovery: operator restores from Tofu state backup, or rotates all tenants (forced re-upload). Documented.
- **[Risk] Bad Tofu state encryption passphrase.** → Mitigation: no new passphrase introduced; reuses existing `TF_VAR_STATE_PASSPHRASE` already covering state.
- **[Risk] `libsodium-wrappers` install-size or compatibility issues in the runtime.** → Mitigation: the library is widely used and tested; native bindings aren't required (WASM build works in Node). If issues arise, `@noble/curves + @noble/ciphers` is a direct pure-JS fallback; both implement the same primitive.
- **[Risk] Key rotation retires a key that a still-active bundle references.** → Mitigation: retirement requires scanning all `workflows/*.tar.gz` manifests for references; the operator-driven retirement workflow enforces this check. Documented.
- **[Risk] Upload handler decrypt-verify leaks timing info about the sk.** → Mitigation: `crypto_box_seal_open` is constant-time with respect to the sk; the primitive's security doesn't depend on decrypt-time side-channel freedom for an attacker who can upload arbitrary ciphertext. No concern.
- **[Trade-off] `plaintextStore` delivered through `run` ctx without a reader in this change.** → Required because the consumer sandbox-side change lands separately. Empty field has zero runtime cost.
- **[Trade-off] `computeKeyId` in core couples an otherwise-pure-types package to a hash function.** → `@workflow-engine/core` already depends on Zod; adding a hash (likely via `node:crypto` on runtime side or a small pure-JS hash in shared utilities) is a minor addition.

## Migration Plan

Order matters — land in this order:

1. Tofu: `envs/persistence/secrets.tf` + outputs; apply operator-driven. Prod keypair generated in state.
2. Tofu: `envs/prod/main.tf` updates (remote_state read + K8s Secret); `envs/staging/main.tf` (own keypair + K8s Secret); `envs/local/main.tf` (own keypair + K8s Secret); `modules/app-instance/workloads.tf` env_from. Apply in order.
3. Runtime: config adds `SECRETS_PRIVATE_KEYS` field. Config becomes required — deploy must happen *after* the K8s Secrets are in place, or startup fails.
4. Runtime: key-store, public-key endpoint, upload decrypt-verify, executor decrypt path, manifest schema additions, core `computeKeyId`.
5. Deploy runtime. Public-key endpoint serves the primary key; upload handler accepts pre-existing bundles (no `secrets` field) unchanged.

**Rollback:** For operator-driven infra (persistence, prod, staging, local), revert the Tofu change and `tofu apply` — the K8s Secret and env_from go away. For the runtime code, the `SECRETS_PRIVATE_KEYS` config field becomes the rollback blocker: if we roll back runtime but keep the env var, the old code doesn't care; if we remove the env var while running new code, config fails at boot. Safe order: revert runtime first, then revert infra.

**Partial-state gotcha:** Between steps 2 and 5 (infra rolled out, runtime not yet deployed), the K8s Secret exists but is unused — harmless. Between steps 5 and any tenant uploading a `secrets`-bearing bundle, the public-key endpoint is live with no consumer — harmless.

## Open Questions

- **libsodium vs `@noble/*` for the runtime's decrypt path.** Both work. Measure install size and cold-start performance before committing. If one is meaningfully better, pick it; otherwise default to `libsodium-wrappers` for ecosystem familiarity.
- **Whether `envs/staging/` should also use `envs/persistence/`** for keypair persistence. Current answer: no — staging rebuildability is the current convention and secret re-generation aligns with staging re-deploys. Revisit if staging gains long-lived state.
