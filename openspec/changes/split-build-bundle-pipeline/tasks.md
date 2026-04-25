## 1. Move libsodium primitives into `@workflow-engine/core/secrets-crypto`

- [x] 1.1 Add `libsodium-wrappers@^0.8.4` to `packages/core/package.json` `dependencies`. Add a `./secrets-crypto` entry to the `exports` field pointing at `./src/secrets/index.ts`.
- [x] 1.2 Create `packages/core/src/secrets/sodium-binding.ts` (file-private, NOT exported through any subpath). Imports `libsodium-wrappers`. Owns the only `import sodium from "libsodium-wrappers"` line in the entire monorepo after this change.
- [x] 1.3 Create `packages/core/src/secrets/seal-ciphertext.ts` exporting `sealCiphertext(plaintext: string, publicKey: Uint8Array) → Uint8Array` — UTF-8-encode plaintext, call `crypto_box_seal`, return raw ciphertext bytes. Imports the binding from §1.2.
- [x] 1.4 Create `packages/core/src/secrets/unseal-ciphertext.ts` exporting `unsealCiphertext(ciphertext, publicKey, secretKey) → Uint8Array` — call `crypto_box_seal_open`, return plaintext bytes. Throws a descriptive error if decryption fails. Imports the binding from §1.2.
- [x] 1.5 Create `packages/core/src/secrets/await-crypto-ready.ts` exporting `awaitCryptoReady(): Promise<void>` — wraps `await sodium.ready` (idempotent, single shared flag). Public name SHALL NOT mention `sodium`. Imports the binding from §1.2.
- [x] 1.6 Create `packages/core/src/secrets/index.ts` re-exporting the three public symbols (`sealCiphertext`, `unsealCiphertext`, `awaitCryptoReady`). Verify NO re-export from `packages/core/src/index.ts`. (Plus `derivePublicKey` + `UnsealError` per design refinement.)
- [x] 1.7 Unit test: `sealCiphertext` then `unsealCiphertext` round-trips a UTF-8 string through a fresh X25519 keypair (use `sodium.crypto_box_keypair` inside the test only).
- [x] 1.8 Unit test (or grep-based assertion): `packages/core/src/index.ts` does NOT transitively import `libsodium-wrappers`. Run `grep -r "libsodium\|crypto_box" packages/core/src/index.ts` — must return zero matches. Run `grep -r "sodium\|libsodium" packages/core/src/secrets/index.ts` — must return zero matches in the public re-export surface (the binding file is fine).

## 2. Refactor runtime to consume `@workflow-engine/core/secrets-crypto`

- [x] 2.1 In `packages/runtime/src/secrets/key-store.ts`, replace the `import sodium from "libsodium-wrappers"` line. `derivePublic(sk)` continues to use `sodium.crypto_scalarmult_base` — that's a keypair-derivation primitive, not seal/unseal. Move it into core too: add `derivePublicKey(secretKey: Uint8Array) → Uint8Array` to the `secrets-crypto` subpath (one more primitive, same scope rationale as §1.3-1.5). Update §1.6 + §1.7 to include it.
- [x] 2.2 Replace the `sodium.crypto_box_seal_open(ct, entry.pk, entry.sk)` call inside `decryptSealed` with `unsealCiphertext(ct, entry.pk, entry.sk)` from core. Keep all surrounding logic (b64 decode, error wrapping) local to the runtime — only the primitive call moves.
- [x] 2.3 Replace `await sodium.ready` (inside `readySodium`) with `await awaitCryptoReady()` from core. Simplify or remove the local `sodiumReady` boolean if it becomes redundant. Rename the local helper to `readyCrypto` to match the library-agnostic naming.
- [x] 2.4 Remove `libsodium-wrappers` from `packages/runtime/package.json` `dependencies`. Remove all orphaned `import sodium ...` lines under `packages/runtime/`. (Tests now use `generateKeypair` + `sealCiphertext` + `derivePublicKey` from core.)
- [x] 2.5 Update any call site that imports `readySodium` from key-store to use the renamed `readyCrypto`. Re-run runtime secrets tests; update import paths as needed. (54 files / 617 tests pass.)

## 3. Refactor SDK CLI to consume `@workflow-engine/core/secrets-crypto`

- [x] 3.1 In `packages/sdk/src/cli/seal.ts`, replace `sodium.crypto_box_seal(...)` (inside `sealOneWorkflow`) with `sealCiphertext(plaintext, publicKey)` from core. Keep the manifest-walking, base64 wrapping, and `MissingSecretEnvError` handling local — only the primitive call moves.
- [x] 3.2 Replace `await sodium.ready` (inside `sealBundleIfNeeded`) with `await awaitCryptoReady()` from core.
- [x] 3.3 Remove the `import sodium from "libsodium-wrappers"` line from `seal.ts`.
- [x] 3.4 Remove `libsodium-wrappers` from `packages/sdk/package.json` `dependencies`.
- [x] 3.5 Verify no `crypto_box_seal*` or `sodium.` occurrences remain anywhere under `packages/sdk/`. Also fixed a latent bug: the Vite plugin's vm context lacked `process`, so any non-default plaintext `env()` would throw "Missing environment variable" at build time. Added `sandboxGlobal.process = { env: process.env }` to `runIifeInVmContext`. `pnpm validate` passes (1105 tests).

## 4. Extract `buildWorkflows` core; delete the public Vite plugin

- [ ] 4.1 In `packages/sdk/src/plugin/index.ts`, identify the `generateBundle` body that performs per-workflow Vite sub-builds (`bundleWorkflowForManifest` + `bundleWorkflowForRuntime`), IIFE-evaluates the manifest-side bundles in a Node `vm` to discover exports, and assembles the `{ workflows: [...] }` manifest (including per-workflow `secretBindings`).
- [ ] 4.2 Create `packages/sdk/src/cli/build-workflows.ts` exporting an async `buildWorkflows(cwd: string, opts?: { workflows?: string[] })` returning `{ files: Map<string, Uint8Array>, manifest: UnsealedManifest }`. Move all discovery + per-workflow JS production into this module. The implementation SHALL NOT write anything to `dist/`. It SHALL invoke Vite/Rolldown's programmatic API with a private internal-only emit-to-memory plugin (file-private; not exported).
- [ ] 4.3 Define/export the `UnsealedManifest` type (same shape as the current `{workflows: [...]}` manifest, with each workflow entry carrying optional `secretBindings`). Reuse existing manifest zod schemas where possible.
- [ ] 4.4 Delete `packages/sdk/src/plugin/` (the entire directory). Remove the `./plugin` subpath from `packages/sdk/package.json`'s `exports` field. Remove any re-export of `workflowPlugin` from `packages/sdk/src/index.ts`.
- [ ] 4.5 Unit test `buildWorkflows`: given a fixture workspace with one workflow declaring plaintext + secret env bindings, assert the returned `manifest.workflows[0].secretBindings` lists the secret name and the returned `files` has one entry keyed on the workflow name with JS bytes; assert nothing is written under `dist/` during the call.

## 5. Rewire `wfe build` to JS-only

- [ ] 5.1 In `packages/sdk/src/cli/build.ts` (or its successor), replace the current Vite-plugin-driven build with `buildWorkflows(cwd)` and write ONLY the per-workflow JS files to `<cwd>/dist/<name>.js`. Do NOT write `dist/manifest.json` or `dist/bundle.tar.gz`.
- [ ] 5.2 Verify the `build` subcommand ignores `--url`, `--owner`, `--user`, `--token`, and `GITHUB_TOKEN`.
- [ ] 5.3 Add a CLI integration test: `wfe build` against a fixture project with `src/foo.ts` + `src/bar.ts` produces `dist/foo.js` + `dist/bar.js`, does NOT produce `dist/manifest.json` or `dist/bundle.tar.gz`, and exits 0.
- [ ] 5.4 Add an integration test asserting `wfe build` with a missing plaintext env var exits non-zero with `Missing environment variable: <name>` on stderr.
- [ ] 5.5 Add an integration test asserting `wfe build` with a missing secret env var exits non-zero with the same message (regression guard for 1a9bc48e).

## 6. Add internal `bundle` function and rewire `wfe upload`

- [ ] 6.1 Create `packages/sdk/src/cli/bundle.ts` exporting `bundle({cwd, url, owner, user?, token?}) → Promise<Uint8Array>`. Implementation: call `buildWorkflows(cwd)`; if any workflow has non-empty `secretBindings`, fetch the pubkey via `fetchPublicKey` (from `seal-http.ts`), pass `(manifest, pubkey, keyId, process.env)` to `sealManifest` from core, receive the sealed manifest; pack tar in-memory from `files` + sealed manifest via the lifted `packTarGz` helper; return bytes.
- [ ] 6.2 Lift the tar-packing logic out of the deleted plugin into `packages/sdk/src/cli/tar.ts` exporting `packTarGz(files, manifest) → Uint8Array` (single home).
- [ ] 6.3 Update `packages/sdk/src/cli/upload.ts`: pipeline becomes resolve auth + URL + owner → `const tarBytes = await bundle({cwd, url, owner, user, token})` → POST `tarBytes`. Drop the build-from-disk → seal-from-disk sequence.
- [ ] 6.4 Confirm the upload pipeline writes nothing to `dist/`. Grep for residual `writeFileSync` / `writeFile` + `dist` on the upload path.
- [ ] 6.5 Update unit tests for the upload pipeline: given a fixture with secrets, assert one pubkey GET + one POST; assert the POSTed tarball's manifest has `secrets` + `secretsKeyId` and no `secretBindings`; assert no file writes under `dist/` during the test.
- [ ] 6.6 Assert that when no workflow has secret bindings, `bundle` does NOT fetch the pubkey and the POSTed tarball's manifest has no `secrets`/`secretsKeyId` field.

## 7. Cross-cutting cleanup

- [ ] 7.1 Grep the repo for `dist/bundle.tar.gz`, `dist/manifest.json`, `@workflow-engine/sdk/plugin`, and `workflowPlugin` references. Update any survivors. Flag any tofu/K8s/helm artifacts that bake the tar into an image build as BLOCKERS for a human to redesign.
- [ ] 7.2 Grep for `import sodium from "libsodium-wrappers"` repo-wide. The only remaining match SHALL be inside `packages/core/src/secrets/`.
- [ ] 7.3 Update `CLAUDE.md`'s "Commands" section: `pnpm build` description should note that workflows emit per-file `.js` only; the tenant tarball is now produced on-demand by `wfe upload`.
- [ ] 7.4 Update `CLAUDE.md` "Upgrade notes" with a 2026-04-25 entry covering: `wfe build` becomes JS-only; `@workflow-engine/sdk/plugin` is deleted; libsodium moves from sdk + runtime to core via the new `./secrets-crypto` subpath.
- [ ] 7.5 `pnpm validate` passes (lint + check + test; WPT not required).

## 8. Dev-probe verification

- [ ] 8.1 `pnpm dev --random-port --kill` boots; stdout contains `Dev ready on http://localhost:<port> (owner=dev)`; auto-upload of `workflows/src/demo.ts` completes without error.
- [ ] 8.2 `GET /api/workflows/dev` (headers: `X-Auth-Provider: local`, `Authorization: User dev`) → 200 lists `demo`.
- [ ] 8.3 `POST /webhooks/dev/demo/hello` → 202; `.persistence/` shows paired `invocation.started` / `invocation.completed` events.
- [ ] 8.4 `pnpm exec wfe build` run manually in `workflows/` produces `workflows/dist/demo.js` and does NOT produce `workflows/dist/bundle.tar.gz` or `workflows/dist/manifest.json`.
- [ ] 8.5 `pnpm exec wfe upload --owner dev --url http://localhost:<port> --user dev` in `workflows/` succeeds end-to-end (204) and leaves no `workflows/dist/bundle.tar.gz` on disk.

## 9. OpenSpec archival

- [ ] 9.1 `pnpm exec openspec validate split-build-bundle-pipeline --strict` passes.
- [ ] 9.2 After implementation + merge, archive via `openspec-archive-change`.
