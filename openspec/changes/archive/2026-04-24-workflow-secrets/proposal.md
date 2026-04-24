## Why

Workflow authors need a way to use sensitive values (API tokens, signing secrets, webhook secrets) in their handlers without committing them to the workflow source, without exposing them to anyone with storage-bucket read access, and without letting them leak into the invocation event archive. Today there is no such mechanism — every env binding ends up as plaintext in `manifest.env` and is publicly inspectable to anyone with tenant-read access to the bundle store.

This change lights up the full user-facing secrets feature on top of two prerequisite changes:

- `workflow-env-runtime-injection` — already landed the `RuntimeWorkflow<Env>` contract, the `env-installer` plugin pattern, and the sandbox `PluginSetup.onPost` hook.
- `secrets-crypto-foundation` — already landed the X25519 keypair infrastructure, the key-store, the `GET /api/workflows/:tenant/public-key` endpoint, the upload decrypt-verify pass, and the executor's per-invocation `plaintextStore` in the run ctx.

With both foundations in place, this change adds the author-facing declaration API (`env({ secret: true })`, `secret(value)`), the Vite plugin routing that moves declared secrets into `manifest.secrets` with their binding list, the CLI flow that fetches the public key and seals each plaintext before upload, and the `secrets` sandbox plugin that extends the existing `env-installer` to populate secret plaintexts onto `globalThis.workflow.env` per invocation and redact them from every outbound `WorkerToMain` message.

## What Changes

- SDK: `env({ name, secret: true })` SHALL be accepted by `defineWorkflow`'s env config. `default` SHALL be rejected at the type level when `secret: true`. Return type of `env({secret:true})` narrows to a dedicated `SecretEnvRef` so downstream routing in the Vite plugin can distinguish secret bindings from plain env bindings.
- SDK: New `secret(value: string): string` export. Returns `value` unchanged; as a side-effect, registers the value with the runtime's plaintext-scrubber set via `globalThis.$secrets.addSecret(value)`. Intended for author-computed or runtime-fetched sensitive values.
- Vite plugin: during build-time discovery, `env({ secret: true })` bindings SHALL NOT be added to `manifest.env`. Instead, their names SHALL be collected into a new `secretBindings: string[]` field on the manifest. The resolved plaintext values SHALL NOT be written into the bundle on disk — the CLI fetches them fresh from its own `process.env` at upload time.
- CLI: `wfe upload --tenant <name>` SHALL detect `manifest.secretBindings` on any workflow. For each binding, the CLI SHALL read `process.env[name]`, call `GET /api/workflows/:tenant/public-key` (once per upload), seal each value with `crypto_box_seal` against the returned pk, write the base64 ciphertext into `manifest.secrets[name]`, set `manifest.secretsKeyId` to the returned keyId, and drop `secretBindings` from the manifest before POST. The server-accepted manifest MUST NOT contain `secretBindings`.
- Runtime: `packages/runtime/src/plugins/env-installer.ts` (created in the prior change) SHALL be extended or replaced by `secrets.ts` that: (a) additionally installs `globalThis.$secrets` with `addSecret`, (b) merges `ctx.plaintextStore` into `workflow.env` per invocation alongside `ctx.envStrings`, (c) implements `onPost` scrubbing plaintexts out of every outbound `WorkerToMain` message using longest-first literal replacement, (d) clears the scrubber set on `onRunFinished`.
- Security: the scrubber SHALL redact literal plaintext values only. Author-side transformations (base64, slicing, hashing) SHALL NOT be caught. This is documented as a known limitation; `secret(derivedValue)` is the escape hatch.
- SECURITY.md R-11 updated to reflect that the `secrets` plugin implements `onPost`; R-11 was introduced by the prior change for no-consumer foundation.

## Capabilities

### New Capabilities
- `workflow-secrets`: author-facing SDK API (`env({secret:true})`, `secret()`), Vite plugin routing of secret bindings, CLI seal-and-upload flow, runtime `secrets` plugin (env + secrets installation, scrubber semantics). The user-facing feature surface.

### Modified Capabilities
- `sdk`: `defineWorkflow` env config type accepts `env({name, secret: true})` (rejects `default` when secret); export new `secret(value)` factory.
- `vite-plugin` (or `workflow-build`): build-time discovery routes `env({secret:true})` bindings into `manifest.secretBindings: string[]` rather than `manifest.env`. Manifest as written to disk contains `secretBindings`, no `secrets` ciphertext field.
- `cli`: `wfe upload` executes the fetch-PK + seal + rewrite-manifest step when `secretBindings` is non-empty.
- `action-upload`: server SHALL reject manifests containing `secretBindings` (that field exists only as an intermediate build-artifact field, dropped before upload). Clear 422 error.
- `workflow-manifest`: `ManifestSchema` as seen by the server stays as prior change defined it (with `secrets` + `secretsKeyId`); the Vite-plugin-emitted shape is a pre-upload variant with `secretBindings`.
- Existing `env-installer` from `workflow-env-runtime-injection` is replaced by the `secrets` plugin in the sandbox composition. `env-installer` removed.

## Impact

- **Packages modified**: `packages/sdk` (env overload, secret() factory, type narrowing), `packages/sdk/src/plugin` (routing secrets to manifest.secretBindings), `packages/sdk/src/cli/upload.ts` (PK fetch + seal + rewrite), `packages/runtime/src/plugins/secrets.ts` (replaces env-installer; adds scrubber + $secrets global), `packages/runtime/src/sandbox-store.ts` (swap env-installer for secrets in composition), `packages/core` (workflow-runtime `RuntimeSecrets` gains the full `addSecret` contract referenced by the plugin).
- **Author behavior**: authors can declare secret env bindings; a workflow with `env({name: "TOKEN", secret: true})` observes `workflow.env.TOKEN` as a plaintext string at runtime, matching the rest of the env surface. `secret(value)` is available for runtime-computed sensitive values.
- **Build artifact**: local `dist/bundle.tar.gz` contains `manifest.secretBindings: string[]` entries for secret-declared keys; it does NOT contain plaintexts or ciphertexts. CLI does the sealing; secrets never touch disk on the author's machine.
- **Upload protocol**: CLI fetches PK, seals, uploads a manifest containing `secrets` + `secretsKeyId` (no `secretBindings`). Server rejects manifests still containing `secretBindings`.
- **Security**: `onPost` scrubber redacts literal plaintext occurrences from every outbound `WorkerToMain` message. Fetch network egress is NOT scrubbed (intentionally — plaintext reaches third-party APIs). Derivative forms of plaintext are not scrubbed (documented limitation).
- **Rotation**: rotation mechanism is inherited from `secrets-crypto-foundation`. Once a new primary key is in place, subsequent `wfe upload` calls seal against it. Older bundles continue to decrypt via retained keys.
- **Tenant re-upload**: existing bundles continue to work. Authors adopting secrets re-upload after SDK bump.
- **openspec/project.md**: no update needed; architectural principles unchanged.
