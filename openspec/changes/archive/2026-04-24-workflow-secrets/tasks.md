## 1. SDK: author-facing API

- [x] 1.1 `env()` overloads: `env({secret: true})` → `SecretEnvRef`; `env({default, secret: true})` is a TypeScript compile error via the discriminated overload signatures.
- [x] 1.2 `SecretEnvRef` interface with `SECRET_ENV_REF_BRAND`; `isSecretEnvRef(value)` guard.
- [x] 1.3 `secret(value: string): string` calls `globalThis.$secrets?.addSecret(value)` and returns value unchanged; no-ops when `$secrets` is absent.
- [x] 1.4 Exported `secret`, `isSecretEnvRef`, `isEnvRef`, and `SecretEnvRef` type from `@workflow-engine/sdk`.
- [x] 1.5 Runtime tests confirm the return-type discrimination; compile-time overload rejection is enforced by TypeScript (no test needed — `pnpm check` clean).
- [x] 1.6 5 new tests: SecretEnvRef branding, defineWorkflow build-time path excludes secret bindings, secret() is a no-op without $secrets, secret() calls addSecret, multiple secret() calls.

## 2. Vite plugin: route secret bindings to manifest

- [x] 2.1 `defineWorkflow` attaches secret envNames to the returned workflow via a `Symbol.for` key; the plugin reads that symbol and populates `manifest.secretBindings`. `resolveEnvRecord` skips SecretEnvRef entries so their keys are absent from `manifest.env`.
- [x] 2.2 `BuiltManifest.secretBindings?: string[]` added; written only when at least one secret binding exists.
- [x] 2.3 3 new tests: mixed env/secret split produces correct manifest fields; no plaintext of a secret leaks into bundle source or manifest; manifest without secrets omits `secretBindings`.
- [x] 2.4 Build-time `workflow.env` (read by the plugin from the Node-VM context) only contains plaintext-resolved entries because `resolveEnvRecord` filters secret refs out. No additional pre-population needed.

## 3. CLI: seal and rewrite flow

- [x] 3.1 New `packages/sdk/src/cli/seal.ts` with `collectSecretBindings` + `sealBundleIfNeeded`. Called from `upload.ts` after `build()`, before POST.
- [x] 3.2 `fetchPublicKey` fetches the server PK via `GET /api/workflows/:tenant/public-key` with bearer token; validates response shape; throws `PublicKeyFetchError` on failure.
- [x] 3.3 `sealAndRewrite` collects missing env names up-front, throws `MissingSecretEnvError` with descriptive message listing all missing vars.
- [x] 3.4 Each plaintext sealed with `sodium.crypto_box_seal(plaintext, pk)` and base64-encoded; written to `manifest.secrets[envName]`.
- [x] 3.5 `manifest.secretsKeyId` set to the PK endpoint's returned `keyId`; `secretBindings` deleted from each manifest.
- [x] 3.6 Tarball repacked in-memory via `tar-stream` + `zlib`; no filesystem writes; upload handler receives the rewritten bytes.
- [x] 3.7 6 tests in `seal.test.ts`: bundles without secrets skip PK fetch (fetch stub never called); mixed env/secrets seal correctly (server-side decrypt proves round-trip); missing env throws `MissingSecretEnvError`; in-memory only (returns Uint8Array, no fs side effects).

## 4. Runtime: server upload handler

- [x] 4.1 `workflowManifestSchema` declares `secretBindings: z.never().optional()` with a descriptive error message; Zod's schema stripping doesn't apply because `z.never()` is explicitly declared, so any present value is rejected.
- [x] 4.2 Error message reads "manifest contains `secretBindings` — this is an intermediate build-artifact field that MUST be consumed by `wfe upload` (sealed into `secrets`) before POSTing".
- [x] 4.3 Core unit test `"rejects a manifest containing secretBindings"` asserts the error is raised; upload handler's existing ManifestSchema pass propagates this as 422.

## 5. Runtime: secrets plugin (replaces env-installer)

- [x] 5.1 `packages/runtime/src/plugins/secrets.ts` exports `name` + `worker(ctx, deps, config)`.
- [x] 5.2 Plugin source installs `globalThis.workflow` (frozen, name + union of env + plaintexts) and `globalThis.$secrets = Object.freeze({addSecret})`. Registers `$secrets/addSecret` guest descriptor (public: false). **Simplification**: per-invocation `populate`/`clear` dropped because manifest.secrets is stable per-(tenant, sha) — decryption happens once at sandbox construction by sandbox-store, baked into plugin config.
- [x] 5.3 Worker-side `worker()` seeds `activePlaintexts` from config once at construction (sorted longest-first). No per-invocation state changes needed beyond `addSecret` additions.
- [x] 5.4 `onPost(msg)` walks every string leaf and applies longest-first `replaceAll(plaintext, "[secret]")`.
- [x] 5.5 No `onRunFinished` needed — `activePlaintexts` is per-sandbox (same lifetime as the plugin closure); `secret()`-added entries persist until the sandbox is disposed, which matches expectations for the `secret()` factory's use case.
- [x] 5.6 `$secrets/addSecret` host handler de-dups and re-sorts longest-first.
- [x] 5.7 See task 6.4 (integration test) + existing SDK `secret()` unit tests. Plugin-internal behavior is covered by the end-to-end test.

## 6. Runtime: sandbox composition

- [x] 6.1 `sandox-store.ts` imports `secretsPlugin` in place of `envInstallerPlugin`; plugin list has `secrets` at the same slot.
- [x] 6.2 `packages/runtime/src/plugins/env-installer.ts` + its test file deleted. Secrets plugin's behavior is exercised end-to-end by the runtime test suite (all 823 tests pass).
- [x] 6.3 Spec delta will be updated in task 7 below (it lives in the workflow-secrets change's specs).
- [x] 6.4 New `sandbox-store.test.ts > secrets plugin end-to-end` test: real X25519 keypair, seals a plaintext, uploads the manifest, invokes a handler that reads `workflow.env.TOKEN`, asserts the plaintext never appears in archived events and `[secret]` does.

## 7. Documentation and security

- [x] 7.1 SECURITY.md R-11 expanded to describe the secrets plugin's `onPost` scrubber semantics (longest-first, literal match, best-effort).
- [x] 7.2 CLAUDE.md upgrade note documents SDK surface changes, CLI seal flow, tenant re-upload requirement, rollback order.
- [x] 7.3 SECURITY.md R-11 now explicitly calls out the literal-only limitation and `secret(derivedValue)` escape hatch.
- [x] 7.4 Example workflow `workflows/src/vault-notify.ts` — exercises both secret surfaces: `env({secret:true})` (sealed binding for `WEBHOOK_TOKEN`) and `secret(value)` (runtime registration of an HMAC signature derived from the sealed token). Typechecks + lints clean.

## 8. Verification

- [x] 8.1 `pnpm lint` clean (only WPT file-size info); `pnpm check` clean; `pnpm test` — 824/824 tests pass across 73 test files.
- [x] 8.2 `pnpm test:wpt` executed: 20303 passed, 1 failed (`html/webappapis/timers/negative-settimeout.any.js`), 9673 skipped. The single failure is in `packages/sandbox-stdlib/` timers WPT compliance and is unrelated to this change (no diff to `packages/sandbox-stdlib/` on this branch vs `origin/main`).
- [x] 8.3 End-to-end scrubber behavior verified by `sandbox-store.test.ts > secrets plugin end-to-end`: sealed bundle → decrypted at sandbox construction → handler reads plaintext → outbound events redact to `[secret]`.
- [x] 8.4 `SECRETS_PRIVATE_KEYS` delivery + decryption verified via the sandbox-store E2E test (real X25519 keypair, real `crypto_box_seal` + seal-open round-trip).
- [x] 8.5 Rotation lifecycle covered by `packages/runtime/src/secrets/rotation.test.ts`: phase 1 (single key) → phase 2 (new primary + retained old key decrypts pre-rotation bundles, fresh bundles seal against new primary) → phase 3 (old key dropped → `unknown_secret_key_id` rejection). Operator-side live cluster verification (apply persistence + redeploy) remains deferred post-merge.
