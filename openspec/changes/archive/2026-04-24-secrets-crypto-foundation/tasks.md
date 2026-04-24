## 1. Infrastructure: keypair generation and delivery

- [x] 1.1 Created `infrastructure/envs/persistence/secrets.tf` with `var.secret_key_ids`, `random_bytes.secret_key` for_each, sensitive CSV output `secrets_private_keys`.
- [x] 1.2 Updated `infrastructure/envs/prod/prod.tf` to pass `secrets_private_keys = data.terraform_remote_state.persistence.outputs.secrets_private_keys` into the app-instance module. The module creates the `app-secrets-key` K8s Secret in the prod namespace.
- [x] 1.3 Created `infrastructure/envs/staging/secrets.tf` with own `var.secret_key_ids` + `random_bytes` + local CSV; wired into app-instance module via `secrets_private_keys`.
- [x] 1.4 Created `infrastructure/envs/local/secrets.tf` with own `var.secret_key_ids` + `random_bytes` + local CSV; wired into app-instance module via `secrets_private_keys`.
- [x] 1.5 Updated `infrastructure/modules/app-instance/` — new `secrets_private_keys` variable, new `kubernetes_secret_v1 "secrets_key"` (`app-secrets-key`), `env_from.secret_ref` in `workloads.tf`, checksum annotation for pod rollout on CSV change.
- [ ] 1.6 Operator: run `tofu plan` for persistence, prod, staging, local; obtain operator review for persistence + prod.
- [ ] 1.7 Operator: apply persistence first, then prod; apply staging and local. Verify each environment's pods receive `SECRETS_PRIVATE_KEYS` (`kubectl exec <pod> -- printenv SECRETS_PRIVATE_KEYS`).

## 2. Core: manifest schema + computeKeyId

- [x] 2.1 Added `secrets?: Record<string, string>` and `secretsKeyId?: string` to `workflowManifestSchema`.
- [x] 2.2 Co-presence rule + regex validation implemented via two `.refine()` passes.
- [x] 2.3 Disjoint-key-names rule implemented via a second `.refine()` that rejects overlap with `env`.
- [x] 2.4 `computeKeyId(publicKey: Uint8Array): Promise<string>` (async because WebCrypto `subtle.digest` is async) and `SECRETS_KEY_ID_BYTES: number = 8` exported from `@workflow-engine/core`.
- [x] 2.5 9 new tests covering co-presence, format, disjoint keys, computeKeyId determinism + length + canonical-input-output fixture.

## 3. Runtime: config and key-store

- [x] 3.1 `SECRETS_PRIVATE_KEYS` added to `createConfig` as a required `z.string().transform(createSecret)` field exposed as `config.secretsPrivateKeys: Secret`.
- [x] 3.2 `packages/runtime/src/secrets/parse-keys.ts` parses the CSV with per-entry validation, duplicate-keyId rejection, and wrong-length sk rejection.
- [x] 3.3 `packages/runtime/src/secrets/key-store.ts` exports `createKeyStore(csv)` with `getPrimary`, `lookup`, `allKeyIds`. Pks are derived once at construction via `sodium.crypto_scalarmult_base`.
- [x] 3.4 Exported `UnknownKeyIdError`, `SecretDecryptError`, `decryptSealed`, `readySodium`, + types via `packages/runtime/src/secrets/index.ts`.
- [x] 3.5 Picked `libsodium-wrappers` (matches the `crypto_box_seal` reference format exactly; widely used). Added `libsodium-wrappers` + `@types/libsodium-wrappers` to `@workflow-engine/runtime`. Core keeps `computeKeyId` using WebCrypto (no libsodium dependency in core).
- [x] 3.6 18 new tests covering CSV parsing edge cases, key derivation correctness, lookup behavior, sealed-box round-trip, and error classes.

## 4. Runtime: public-key API route

- [x] 4.1 Created `packages/runtime/src/api/public-key.ts` with `createPublicKeyHandler({keyStore})`.
- [x] 4.2 Wired into `apiMiddleware`; added `app.use("/workflows/:tenant/*", requireTenantMember())` to ensure the route inherits the same auth/tenant-membership check as `POST /api/workflows/:tenant`.
- [x] 4.3 3 integration tests: 200 with correct shape + expected pk; keyId fingerprint matches sha256(pk)[0:8] hex; invalid tenant identifier returns 404.

## 5. Runtime: upload handler decrypt-verify

- [x] 5.1 Added `packages/runtime/src/secrets/verify-manifest.ts`; wired into `upload.ts` handler after gzip extraction but before `registerTenant`. Runs only when `manifest.json` parses against `ManifestSchema`; unrelated parse failures fall through to registry's uniform error path.
- [x] 5.2 Unknown `secretsKeyId` → 400 `{error: "unknown_secret_key_id", tenant, workflow, keyId}`.
- [x] 5.3 Decrypt failure → 400 `{error: "secret_decrypt_failed", tenant, workflow, envName}`.
- [x] 5.4 Decrypted bytes are zero-cleared with `plaintext.fill(0)` after verification and dropped out of scope; no logger/console dumps.
- [x] 5.5 6 tests in `verify-manifest.test.ts` covering unknown keyId, garbage ciphertext, wrong-pk sealing, first-failure reporting, and valid round-trip; existing upload tests still pass with the stub key-store.

## 6. Runtime: executor decrypt path

- [x] 6.1 `decryptWorkflowSecrets(workflow, keyStore)` helper in executor.ts builds `plaintextStore: Record<string, string>` by decrypting each `manifest.secrets` entry via `decryptSealed`.
- [x] 6.2 plaintextStore is held locally in `runInvocation` scope. **Not forwarded to the sandbox yet** — the workflow-secrets change will add a consumer plugin that reads it; sandbox's `sb.run` signature stays unchanged here. Documented in-code.
- [x] 6.3 `wipePlaintextStore(store)` overwrites each value with `""` in the `finally` block; `bytes.fill(0)` wipes decrypted bytes before discarding.
- [x] 6.4 Decrypt errors caught inside the try; returned as `{ok: false, error: {message}}` with descriptive message (e.g. `unknown secretsKeyId "X"`). Trigger sources render 500 per existing behavior.
- [x] 6.5 3 new executor tests: no secrets → ok; sealed secrets → decrypts + runs handler; unknown keyId → ok:false with descriptive error. Existing 10 tests still pass after passing `keyStore` via options.

## 7. Documentation

- [x] 7.1 SECURITY.md §5 gains "Workflow secret-key management" subsection covering key location, rotation, and the storage-operator-cannot-unseal property.
- [x] 7.2 CLAUDE.md upgrade note added documenting env-var + operator apply order, rotation, rollback.
- [x] 7.3 Endpoint documented inline in `packages/runtime/src/api/public-key.ts` comments + SECURITY.md; a dedicated runbook entry can follow later if operators want one.

## 8. Verification

- [x] 8.1 `pnpm lint` clean (only WPT file-size info); `pnpm check` clean; `pnpm test` — 809/809 tests pass across 72 test files.
- [x] 8.2 `tofu validate` succeeded for persistence, prod, staging, and local (see task 1 output).
- [ ] 8.3 Operator: E2E on a local cluster (deferred — in-repo tests cover the decrypt path; full cluster E2E is an operator task post-merge).
- [ ] 8.4 Operator: curl the public-key endpoint in each deployed environment after merge (deferred — in-repo integration tests validate the endpoint's shape).
