## Why

The upcoming workflow-secrets feature requires a server-side cryptographic foundation: an X25519 keypair per environment, a key-store that parses it from an env var, a public-key endpoint so the CLI can fetch sealing material, and executor plumbing that decrypts manifest ciphertexts per invocation. None of this is user-facing on its own — it is the infrastructure + server plumbing that the author-facing feature depends on.

Shipping this foundation separately has three benefits. First, it lets the infrastructure change (new K8s Secret, new Tofu resources in `envs/persistence/`) land in its own PR with its own operator review, decoupled from the runtime code. Second, the public-key endpoint and key-store can be deployed and live on production with zero observable behavior change — useful for validating the crypto primitives before any tenant depends on them. Third, it keeps the follow-up workflow-secrets change small and focused on the author surface + the scrubber semantics.

## What Changes

- **INFRA** Add `envs/persistence/secrets.tf` generating a list of X25519 keypairs via `random_bytes`, keyed by a `var.secret_key_ids` list variable (primary first). Sensitive output `secrets_private_keys` (CSV of `keyId:base64(sk)` entries).
- **INFRA** `envs/prod/main.tf` reads the output via `terraform_remote_state` and creates a K8s Secret `app-secrets-key` in the prod namespace. `envs/staging/main.tf` and `envs/local/main.tf` generate their own keypair list (per-environment independence).
- **INFRA** `modules/app-instance/workloads.tf` adds `env_from.secret_ref` for `app-secrets-key`, injecting `SECRETS_PRIVATE_KEYS` into the app pod.
- Add `SECRETS_PRIVATE_KEYS` field to `createConfig` in `packages/runtime/src/config.ts`, wrapped via `createSecret()` for redaction.
- Add `packages/runtime/src/secrets/key-store.ts`: parses the CSV, derives public keys from secret keys on demand via `crypto_scalarmult_base`, exposes `getPrimary()` (the active sealing keypair) and `lookup(keyId)` (for decrypting older bundles). Also exports `computeKeyId(publicKey)` — `sha256(publicKey).slice(0, 8)` as lowercase hex.
- Add a new `computeKeyId` helper to `@workflow-engine/core` alongside other protocol-level constants so it is shared between the runtime's key-store, the upload handler, and future CLI sealing code.
- Extend the workflow manifest schema (`@workflow-engine/core`) with two optional fields: `secrets?: Record<string, string>` (base64 sealed-box ciphertexts keyed by envName) and `secretsKeyId?: string` (the 16-char lowercase hex fingerprint of the sealing public key). No consumer populates these fields yet.
- Add route `GET /api/workflows/:tenant/public-key` behind the existing `requireTenantMember` middleware. Returns `{ algorithm: "x25519", publicKey: "<b64 of primary pk>", keyId: "<fingerprint>" }`.
- Extend `POST /api/workflows/:tenant` upload handler: for every workflow whose manifest entry includes `secrets`, verify each base64 ciphertext decrypts with the sk looked up by `secretsKeyId`. On failure, respond 400 `{ error: "secret_decrypt_failed", ... }`. On unknown `secretsKeyId`, respond 400.
- Extend executor `invoke()` in `packages/runtime/src/executor/index.ts`: when the manifest entry has `secrets`, decrypt each ciphertext into a per-invocation `plaintextStore: Record<string, string>` keyed by envName, pass through to the sandbox via the `run` message's ctx as `ctx.plaintextStore`, and zero/clear the record in `finally`. **No consumer uses `ctx.plaintextStore` yet** — the field is delivered to the sandbox but not read. The workflow-secrets change lights it up.

## Capabilities

### New Capabilities
- `secrets-key-management`: `SECRETS_PRIVATE_KEYS` config field, key-store parser, `getPrimary` / `lookup(keyId)` API, `computeKeyId(publicKey)` helper shared in core. The crypto-primitive layer that the public-key endpoint and the upload/decrypt paths all call into.
- `secrets-public-key-api`: The `GET /api/workflows/:tenant/public-key` route, its auth gating (inherits `requireTenantMember`), response shape, and keyId fingerprint derivation.

### Modified Capabilities
- `workflow-manifest`: Adds optional `secrets: Record<string, string>` and `secretsKeyId: string` manifest fields. Validation requires both or neither.
- `action-upload`: Upload handler decrypts-verifies `manifest.secrets` ciphertexts against the key looked up by `secretsKeyId`. Adds 400 response cases for unknown keyId and decryption failure.
- `executor`: `invoke()` decrypts manifest ciphertexts per invocation into `plaintextStore`, delivers via the `run` message ctx, and wipes after completion.
- `runtime-config`: Adds `SECRETS_PRIVATE_KEYS` required config field (string, CSV format, `createSecret` wrapped).
- `infrastructure`: Adds keypair provisioning to `envs/persistence/` (prod), `envs/staging/`, `envs/local/`; adds K8s Secret + pod env_from wiring.

## Impact

- **Packages modified**: `packages/core` (manifest schema additions + `computeKeyId`), `packages/runtime` (new `secrets/key-store.ts`, new `api/public-key.ts`, upload-handler decrypt-verify, executor decrypt path, config field).
- **Packages new**: none.
- **Infrastructure**: `envs/persistence/secrets.tf` new; `envs/prod/main.tf` reads via remote_state + creates K8s Secret; `envs/staging/main.tf` and `envs/local/main.tf` generate own keypair + K8s Secret; `modules/app-instance/workloads.tf` adds `env_from.secret_ref`. `SECRETS_PRIVATE_KEYS` env var delivered to app pods.
- **Env vars**: new required `SECRETS_PRIVATE_KEYS` in config. Missing or malformed → `createConfig` throws at startup, pod fails fast. CI must provision the Tofu keypair list before deploying runtime code that requires this env.
- **Dependencies**: libsodium (or `tweetnacl` / `@noble/curves`) added to `@workflow-engine/core` and `packages/runtime` for `crypto_box_seal` + `crypto_box_seal_open` + `scalarmult_base`. Specific library TBD in design.
- **API surface**: new authenticated route `GET /api/workflows/:tenant/public-key`. No new authentication logic — reuses `requireTenantMember`.
- **Database / storage**: no changes to event archive, pending/, or storage backend.
- **Observable behavior**: none until workflow-secrets change lights up the consumers. Existing tenant bundles upload and run identically; `manifest.secrets` is optional and absent from all current bundles. The public-key endpoint responds with the primary key but no client calls it yet.
- **Upgrade path**: operator-driven apply of the persistence + prod Tofu projects before runtime deploys that require the env var. No tenant re-upload. No state wipe. Rotation is non-breaking: prepend a new id to `var.secret_key_ids`, apply, redeploy; retire an old id only once no tenant references it (no tenant does in this change).
- **openspec/project.md**: no update needed; architectural principles unchanged.
