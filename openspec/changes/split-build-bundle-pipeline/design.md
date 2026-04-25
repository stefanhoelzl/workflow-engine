## Context

Today the `wfe` CLI has two public subcommands (`build`, `upload`), both anchored on a single `build()` function in `packages/sdk/src/cli/build.ts` that invokes `viteBuild(defaultViteConfig(cwd))`. The Vite plugin at `packages/sdk/src/plugin/index.ts` (`generateBundle` hook) does workflow discovery via IIFE eval in a Node `vm` context, builds a manifest object, and writes `dist/manifest.json` and `dist/bundle.tar.gz` as side effects. `wfe upload` reads that tar from disk, calls `sealBundleIfNeeded` (which extracts the tar, fetches the server pubkey, rewrites the manifest, and re-tars in memory), then POSTs.

In parallel, the runtime independently unseals workflow secrets at load time. `packages/runtime/src/secrets/key-store.ts:135-163` (`decryptSealed`) calls `sodium.crypto_box_seal_open` and is exercised from `workflow-registry.ts:159` and `sandbox-store.ts:88`. The CLI seal side and the runtime unseal side share an implicit wire-format contract (`secretBindings` ↔ `secrets` + `secretsKeyId`) but no code; both packages depend on `libsodium-wrappers@^0.8.4` directly.

Three problems with this shape:

1. **`wfe build` emits unsealed, undeployable tarballs.** When any workflow declares `env({secret:true})`, the emitted `manifest.json` still carries `secretBindings` and trigger-config fields still contain `\x00secret:NAME\x00` sentinel strings.
2. **Sealing inside `upload` pays a tar round-trip it doesn't need.** The tar is written to disk, then immediately extracted back into memory for rewriting.
3. **Two parallel libsodium consumers and an implicit format contract.** Seal/unseal drift would be silent until a workflow fails to start.

Verified during pre-implementation exploration:

- Empirically, no monorepo code outside `packages/sdk` imports `@workflow-engine/sdk/plugin` or `workflowPlugin`. The `cli` spec already forbids user-authored `vite.config.ts`.
- `@workflow-engine/core/package.json` currently depends only on `ajv` + `zod`. `index.ts` is consumed by the sandbox-plugin esbuild step, which does NOT reliably resolve sibling `.ts` files. Anything pulling libsodium MUST be exposed through a separate subpath (analogous to existing `/test-utils`) so it never reaches the sandbox bundle.

Secret env-var presence enforcement (the first half of the build-is-broken story) was already resolved in commit 1a9bc48e by unifying `resolveEnvRecord`. This proposal addresses the sealing half plus the consolidation.

## Goals / Non-Goals

**Goals:**
- `wfe build` is a fast, offline, JS-only step suitable for "does this compile?" local iteration.
- `wfe upload` produces a deployable sealed tar with one pipeline; nothing unsealed ever hits disk.
- `buildWorkflows(cwd)` is the single discovery + per-workflow build implementation, called by every code path that needs workflow JS or manifest data.
- Seal + unseal logic lives in `@workflow-engine/core` as the single wire-format authority. CLI and runtime depend on `core` for crypto, not on libsodium directly.

**Non-Goals:**
- Adding a public `wfe bundle` subcommand (rejected during design interview).
- Changing the pubkey endpoint, auth scheme, tar format, or manifest schema.
- Changing the SDK `env()`/`secret()` surface (already shipped in 1a9bc48e).
- Changing the runtime's keypair-loading-from-CSV concern (`parseSecretsPrivateKeys`); only the cryptographic primitive moves.
- Adding a pubkey cache or offline-seal mode.

## Decisions

### Decision 1: `wfe build` skips tar + manifest emission

`wfe build` runs the full workflow discovery (IIFE eval, env resolution, trigger collection, secret-binding detection) so compile errors, missing env vars, and malformed triggers surface exactly as they do under `upload`. What it does NOT do is serialize `manifest.json` or pack `dist/bundle.tar.gz`. It writes only per-workflow `<name>.js` files to `dist/`.

**Alternatives considered:**

- *Keep `build` producing an unsealed tar and mark it "intermediate".* Rejected — the artifact shape is indistinguishable from a deployable tar; users will mis-ship it. Also reintroduces the no-unsealed-on-disk invariant violation.
- *Have `build` also fetch the pubkey and seal.* Rejected — sealing requires `--url --owner` + auth, which breaks the "zero-arg offline" use case.
- *Make `build` produce an unsealed tar with an explicit `.unsealed` suffix.* Rejected — same disk-leak concern.

### Decision 2: `bundle` is an internal module function, not a subcommand

A new module function `bundle({cwd, url, owner, user?, token?}) → Promise<Uint8Array>` lives in `packages/sdk/src/cli/bundle.ts` and is called by `upload`. It is not exposed via the `wfe` binary.

**Alternative considered and rejected:**

- *Public `wfe bundle` subcommand.* The only use case (CI/airgap: seal in one job, POST in another) isn't currently needed. Keeping the CLI surface minimal avoids a contract we'd have to support forever.

### Decision 3: Delete `packages/sdk/src/plugin/`; fold discovery into `buildWorkflows`

Originally drafted as "extract the plugin's body and turn the plugin into a thin shim." Re-evaluated after verifying that no monorepo code outside `packages/sdk` imports the plugin and that the `cli` spec already forbids external `vite.config.ts` consumers. With no external consumer, there's nothing to shim for.

The current `generateBundle` body (per-workflow Vite sub-builds for manifest+runtime variants, IIFE eval in `vm`, manifest assembly, tar packing) is folded into `packages/sdk/src/cli/build-workflows.ts`. `buildWorkflows` invokes Vite/Rolldown's programmatic API directly, with a private in-process plugin that emits to memory rather than writing to `dist/`.

This deletion is also load-bearing for the "no unsealed bundle on disk" invariant: as long as a Vite plugin existed that wrote `dist/bundle.tar.gz` as a side effect, somebody would eventually invoke it without the seal step (CI cache, ad-hoc debugging, future contributor unaware of the contract). Deleting the plugin removes the temptation and the foot-gun simultaneously.

**Alternatives considered:**

- *Plugin-as-shim* (the original Decision 3). Rejected — preserves a public surface nobody uses while leaving the disk-write tempting.
- *Mode flag on the plugin.* Rejected — same as above.

### Decision 4: Move the libsodium-touching primitives into `@workflow-engine/core/secrets-crypto`

The genuinely shared piece between CLI seal and runtime unseal is the libsodium primitive itself: `crypto_box_seal` for sealing, `crypto_box_seal_open` for unsealing. Everything else differs:

- The CLI walks `manifest.workflows`, finds entries with `secretBindings`, reads `env[name]` per binding, and base64-encodes ciphertexts. The CLI knows the (single) server public key; it doesn't have a keystore.
- The runtime resolves `workflow.secretsKeyId → (pk, sk)` through a multi-key `SecretsKeyStore` (`packages/runtime/src/secrets/key-store.ts`) and decrypts ciphertexts one at a time inside `decryptWorkflowSecrets`. It doesn't walk a manifest; it doesn't have a `bindings` list to iterate.

Forcing both sides through a `sealManifest` / `unsealWorkflow` API would either bloat one side with unused parameters or paper over the shape mismatch with adapters. The clean cohesion is to consolidate only the libsodium calls and let each side keep its domain logic.

`packages/core/src/secrets/` (new directory) hosts:

- `sealCiphertext(plaintext: string, publicKey: Uint8Array) → Uint8Array` — UTF-8-encode, sealed-box-encrypt, return raw ciphertext bytes.
- `unsealCiphertext(ciphertext: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array) → Uint8Array` — sealed-box-decrypt, return plaintext bytes.
- `awaitCryptoReady(): Promise<void>` — initialises the backing crypto. Name is library-agnostic; callers don't see "sodium" anywhere.

Exposed via a new `./secrets-crypto` subpath in `packages/core/package.json`, mirroring the existing `./test-utils` pattern.

**Per-side wrappers stay in place:**

- `packages/sdk/src/cli/seal.ts` (or its successor) keeps `sealManifest` / `sealAndRewrite`: walks bindings, calls `sealCiphertext` per name, base64-encodes, mutates manifest. Drops the direct libsodium import.
- `packages/runtime/src/secrets/key-store.ts` keeps `decryptSealed`: resolves keyId → `(pk, sk)`, base64-decodes ciphertext, calls `unsealCiphertext`. Drops the direct libsodium import. Keypair derivation (`derivePublic`) and fingerprint logic stay in the keystore — those concerns are runtime-specific.

The HTTP-only concern (`fetchPublicKey` against `/api/workflows/<owner>/public-key`) stays in `packages/sdk/src/cli/seal-http.ts` — pure CLI, no runtime counterpart.

**Why a subpath instead of the main entry:** `packages/core/src/index.ts` is consumed by the sandbox-plugin esbuild step, which doesn't reliably resolve sibling `.ts` files and which must NOT pull libsodium into the sandbox bundle. The existing `/test-utils` subpath demonstrates the pattern.

**Why the export names hide the backing library:** the choice of `crypto_box_seal` is internal. If we ever switch to `@noble/ciphers` or `tweetnacl`, callers shouldn't need code changes. `awaitCryptoReady` (rather than `awaitSodiumReady`) and `sealCiphertext` (rather than `sealBox`) make that abstraction explicit.

**Alternatives considered:**

- *Higher-level `sealManifest` / `unsealWorkflow` in core.* Rejected — `unsealWorkflow(workflow, privkey)` doesn't fit the runtime's multi-key keystore shape, and `sealManifest` is exclusively a CLI concern. Either we add unused parameters or we add adapter boilerplate; both are worse than just sharing the primitives.
- *Leave seal in SDK, unseal in runtime.* Rejected — preserves the dual libsodium dep that motivated this consolidation.
- *Put primitives into a new package (`@workflow-engine/secrets`).* Rejected — a third package for two functions is over-architecture; `core` is the right home for cross-package wire-format authority.
- *Inline primitives into core's `index.ts`.* Rejected — would pull libsodium into the sandbox bundle.

### Decision 5: `pnpm --filter workflows build` switches to JS-only output

`workflows/package.json`'s `build` script already invokes `wfe build`, so the script line itself doesn't change — but its output does. `workflow-build`'s `Root build includes workflows` scenario is updated: `pnpm build` no longer produces `workflows/dist/bundle.tar.gz` or `workflows/dist/manifest.json`. Anyone who needs a deployable tarball calls `wfe upload` (or `bundle` programmatically).

### Decision 6: Single in-memory tar pack; delete `sealBundleIfNeeded`

Today's `sealBundleIfNeeded` (`packages/sdk/src/cli/seal.ts`) extracts a tar, rewrites the manifest inside the entry list, and re-tars. After this change, `bundle` has the manifest object in memory before any tar is packed, so the helper has no remaining purpose. Deleted. `bundle` instead does:

```
const { files, manifest } = await buildWorkflows(cwd);
const sealed = needsSeal(manifest)
  ? sealManifest(manifest, await fetchPublicKey(...), env)
  : manifest;
return packTarGz(files, sealed);
```

One tar pack, one manifest, no round-trip.

## Risks / Trade-offs

- **[Direct vite-plugin consumers exist outside the monorepo.]** Risk for any third party who imported `@workflow-engine/sdk/plugin` from a published version. **Mitigation:** the package isn't published outside this monorepo; the deletion is documented in CLAUDE.md upgrade notes. If we later discover a consumer, restore as a thin re-export over `buildWorkflows`.
- **[Root `pnpm build` no longer yields a deployable tarball.]** Any CI/tooling that greps `workflows/dist/bundle.tar.gz` after `pnpm build` breaks. **Mitigation:** task to grep the repo for residual references; CI changes; spec scenario flipped.
- **[libsodium load timing in `core`.]** `libsodium-wrappers` requires `await sodium.ready` before use. CLI and runtime must `await` it before calling `sealManifest` / `unsealWorkflow`. **Mitigation:** wrap in an async init helper inside `core/secrets-crypto` so callers don't manage `sodium.ready` themselves; both call sites are already async paths.
- **[Sandbox bundle accidentally pulls libsodium.]** If a contributor adds a re-export of `secrets-crypto` from `core/index.ts`, the sandbox bundle bloats. **Mitigation:** task to add a unit test asserting that `index.ts` does not transitively import libsodium; documented in the `core-package` spec.
- **[Dropping `dist/manifest.json` impedes debugging.]** A user previously running `wfe build` and inspecting the manifest can't anymore. **Mitigation:** call out in upgrade notes; if the need surfaces, add a `--emit-manifest` debug flag (out of scope).

## Migration Plan

1. Land the refactor with no feature flag. CLI surface unchanged for `upload`; only `build`'s observable output changes (no tarball/manifest).
2. Update CLAUDE.md "Upgrade notes" with a 2026-04-25 entry covering: `wfe build` is now JS-only; `@workflow-engine/sdk/plugin` is deleted; libsodium moves from sdk+runtime to core.
3. Grep the codebase for `dist/bundle.tar.gz`, `dist/manifest.json`, `@workflow-engine/sdk/plugin`, and `workflowPlugin` references; update any that survive (none expected outside SDK).
4. `pnpm validate` + `pnpm dev` auto-upload of `workflows/src/demo.ts` must continue to pass.
5. Spot-check that the existing runtime plaintext-on-load tests (around `decryptSealed`) still pass after the swap to `unsealWorkflow`.

## Open Questions

_None._ Design questions resolved during the pre-proposal interview and the subsequent verification spike.
