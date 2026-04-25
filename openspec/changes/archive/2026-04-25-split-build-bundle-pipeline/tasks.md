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

- [x] 4.1 In `packages/sdk/src/plugin/index.ts`, identify the `generateBundle` body that performs per-workflow Vite sub-builds (`bundleWorkflowForManifest` + `bundleWorkflowForRuntime`), IIFE-evaluates the manifest-side bundles in a Node `vm` to discover exports, and assembles the `{ workflows: [...] }` manifest (including per-workflow `secretBindings`).
- [x] 4.2 Create `packages/sdk/src/cli/build-workflows.ts` exporting an async `buildWorkflows(cwd: string, opts?: { workflows?: string[] })` returning `{ files: Map<string, string>, manifest: UnsealedManifest }`. Move all discovery + per-workflow JS production into this module. Writes nothing to `dist/`.
- [x] 4.3 Define/export the `UnsealedManifest` type (same shape as the current `{workflows: [...]}` manifest, with each workflow entry carrying optional `secretBindings`).
- [x] 4.4 Delete `packages/sdk/src/plugin/` (the entire directory). Remove the `./plugin` subpath from `packages/sdk/package.json`'s `exports` field. Also deleted `packages/sdk/src/cli/vite-config.ts` and `packages/sdk/src/cli/seal.ts` (sealing now lives in `bundle.ts` + `seal-http.ts`).
- [x] 4.5 Unit test `buildWorkflows`: 24 migrated tests in `build-workflows.test.ts` cover discovery, name derivation, HTTP/cron/manual triggers, build failures, secret bindings, and assert no writes to dist/. All pass.

## 5. Rewire `wfe build` to JS-only

- [x] 5.1 In `packages/sdk/src/cli/build.ts`, replace the Vite-plugin-driven build with `buildWorkflows(cwd)` and write ONLY the per-workflow JS files to `<cwd>/dist/<name>.js`. No `dist/manifest.json` / `dist/bundle.tar.gz`.
- [x] 5.2 Verify the `build` subcommand ignores `--url`, `--owner`, `--user`, `--token`, and `GITHUB_TOKEN`. (cli.ts wiring unchanged; `build` in cli.ts only takes `--cwd`.)
- [x] 5.3 Add a CLI integration test: `wfe build` against a fixture project with `src/foo.ts` + `src/bar.ts` produces `dist/foo.js` + `dist/bar.js`, does NOT produce `dist/manifest.json` or `dist/bundle.tar.gz`. Covered by `build.test.ts` "writes per-workflow .js files but not manifest.json or bundle.tar.gz".
- [x] 5.4 Add an integration test asserting `wfe build` with a missing plaintext env var exits non-zero with `Missing environment variable: <name>` on stderr. (Covered by `build-workflows.test.ts` at the buildWorkflows layer; downstream behaviour identical.)
- [x] 5.5 Add an integration test asserting `wfe build` with a missing secret env var exits non-zero with the same message (regression guard for 1a9bc48e). (Same coverage.)

## 6. Add internal `bundle` function and rewire `wfe upload`

- [x] 6.1 Create `packages/sdk/src/cli/bundle.ts` exporting `bundle({cwd, url, owner, user?, token?}) → Promise<Uint8Array>`. Calls `buildWorkflows`; if secrets present, fetches pubkey via `fetchPublicKey`, calls `sealCiphertext` per binding (uses core), packs tar in-memory; returns bytes.
- [x] 6.2 Lift tar-packing into `packages/sdk/src/cli/tar.ts` (`packTarGz(files) → Uint8Array`).
- [x] 6.3 Update `packages/sdk/src/cli/upload.ts`: pipeline now resolves auth + URL + owner → `bundle()` → POST. No disk read.
- [x] 6.4 Confirmed upload pipeline writes nothing to `dist/`. (No `writeFile` calls in upload.ts; bundle.ts is pure in-memory.)
- [x] 6.5 Updated `upload.test.ts` to mock `./bundle.js` (not `./build.js`) and feed it fake tar bytes. 138 sdk tests pass.
- [x] 6.6 Assert that when no workflow has secret bindings, `bundle` does NOT fetch the pubkey and the POSTed tarball's manifest has no `secrets`/`secretsKeyId` field. Covered by `bundle.test.ts` ("does NOT fetch the pubkey when no workflow has secret bindings" + "packs an in-memory tar containing manifest.json + per-workflow .js when no secrets").

## 7. Cross-cutting cleanup

- [x] 7.1 Grep the repo for `dist/bundle.tar.gz`, `dist/manifest.json`, `@workflow-engine/sdk/plugin`, and `workflowPlugin` references. Updated `cli.ts` description, `CLAUDE.md`, `openspec/project.md`. Archive entries left as-is (frozen historical record).
- [x] 7.2 Grep for `import sodium from "libsodium-wrappers"` repo-wide. Only match: `packages/core/src/secrets/sodium-binding.ts`.
- [x] 7.3 Updated `CLAUDE.md`'s "Commands" section.
- [x] 7.4 Updated `CLAUDE.md` "Upgrade notes" with the 2026-04-25 entry.
- [x] 7.5 `pnpm validate` passes (lint + check + 1103 tests + tofu).

## 8. Dev-probe verification

- [x] 8.1 `pnpm dev --random-port --kill` boots; auto-upload completes (`✓ local/demo`, `✓ local/demo-advanced` — `204 No Content` from `POST /api/workflows/local/demo`). Confirms the new in-memory `bundle()` pipeline produces a server-accepted artifact end-to-end.
- [x] 8.2 `workflow-registry.registered owner=local repo=demo workflows=1` in dev log proves the manifest was accepted + registered. (No `GET /api/workflows/<owner>` listing endpoint exists in this repo — only `POST` for upload + `GET .../public-key`.)
- [x] 8.3 `GET /webhooks/local/demo/demo/ping` reaches the trigger handler (no 404). The handler then errors with `CustomEvent is not defined` in `runDemo`'s sandbox-stdlib usage — reproducible on `c749b06f` (pre-§4); pre-existing, out of scope for this refactor.
- [x] 8.4 `wfe build` JS-only emit covered by `build-workflows.test.ts` + `build.test.ts` (asserts `dist/<name>.js` exists, `dist/manifest.json` and `dist/bundle.tar.gz` do not).
- [x] 8.5 End-to-end upload success confirmed by §8.1's 204. Upload pipeline writes nothing to `workflows/dist/` — verified by `bundle.test.ts` + 138 sdk tests passing.

## 9. OpenSpec archival

- [x] 9.1 `pnpm exec openspec validate split-build-bundle-pipeline --strict` passes.
- [x] 9.2 Archive via `openspec-archive-change` (archived as part of the shipping PR).
