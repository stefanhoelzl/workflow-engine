## Why

`wfe build` today produces corrupted bundles: the emitted `dist/bundle.tar.gz` carries `manifest.secretBindings` and `\x00secret:NAME\x00` sentinel strings in trigger configs. The server's manifest schema rejects both, so the artifact is not directly deployable — only `wfe upload` can finalize it (by fetching the server public key, sealing, and re-taring). That makes `build` a footgun: it exits 0, writes a tarball, and users can't deploy it. The genuine use case for bare `build` — fast local iteration / type-check — does not need a tarball at all.

Beyond fixing `build`, the same refactor surfaces an opportunity to consolidate the secrets wire-format authority. Today the CLI seals and the runtime unseals using two parallel libsodium dependencies (`packages/sdk/package.json` + `packages/runtime/package.json`), with the manifest-field shape (`secretBindings` ↔ `secrets` + `secretsKeyId`) defined implicitly by both sides. Promoting both to `@workflow-engine/core` collapses the contract into one place and lets seal/unseal drift become a compile error instead of a silent on-the-wire mismatch.

Secret env-var presence enforcement (the first half of the build-is-broken story) was resolved in commit 1a9bc48e by unifying `resolveEnvRecord`. This proposal addresses the sealing half, plus the consolidation.

## What Changes

- **BREAKING** `wfe build` no longer emits `dist/manifest.json` or `dist/bundle.tar.gz`. It runs TS→JS compile and workflow discovery (IIFE eval, env resolution + presence check, trigger collection), then writes only per-workflow `<name>.js` files to `dist/`. Fully offline; zero args.
- **BREAKING** No code path writes an unsealed bundle to disk. `wfe upload` produces the sealed tar in memory and POSTs directly. `dist/` never contains a tar or manifest.
- **BREAKING** The public `@workflow-engine/sdk/plugin` export and the `packages/sdk/src/plugin/` directory are deleted. Empirically nothing in the monorepo imports the plugin from outside the SDK package itself, and the `cli` spec already forbids user-authored `vite.config.ts`. Workflow discovery + per-workflow Vite/Rolldown sub-builds move into a private in-memory mechanism inside `buildWorkflows`.
- Introduce `@workflow-engine/core/secrets-crypto` (new subpath export, analogous to `/test-utils`) exporting `sealManifest` and `unsealWorkflow` plus their result types. Both share one libsodium dependency, one manifest-field contract.
- Introduce a pure `buildWorkflows(cwd) → { files, manifest }` core in the SDK that runs Vite/Rolldown in-process with a private internal-only emit-to-memory plugin. `wfe build`, the internal `bundle` function, and `wfe upload` all call it; nothing else does.
- Introduce an internal `bundle({cwd, url, owner, user?, token?}) → Promise<Uint8Array>` module function. Calls `buildWorkflows`, optionally seals via `core/secrets-crypto`, packs tar in memory, returns bytes. Not a `wfe` subcommand.
- `wfe upload` surface unchanged: same args, same response codes. Internally routes through `bundle`. The old `sealBundleIfNeeded` (tar-extract → rewrite → re-tar) is deleted; sealing operates directly on the in-memory manifest object before the single tar pack.
- `packages/runtime/src/secrets/key-store.ts` `decryptSealed` is replaced by a call to `unsealWorkflow` from `@workflow-engine/core/secrets-crypto`. Runtime `package.json` drops its direct `libsodium-wrappers` dependency. `packages/sdk/package.json` drops its direct `libsodium-wrappers` dependency. `packages/core/package.json` adds `libsodium-wrappers` (net: same monorepo-wide dep count, one fewer call site).

## Capabilities

### New Capabilities

_None._ All changes land as deltas on existing capabilities.

### Modified Capabilities

- `cli`: `wfe build` semantics change (JS-only, no tar/manifest, no network). `wfe upload` surface unchanged but routes through the new in-memory `bundle`. Sealing implementation moves to `@workflow-engine/core/secrets-crypto`.
- `workflow-build`: pipeline collapses around the in-memory `buildWorkflows` core. The `Vite plugin builds workflows into a single tenant tarball` requirement is REMOVED (the plugin is deleted). The `Root build includes workflows` scenario flips: `pnpm build` no longer produces `bundle.tar.gz`.
- `core-package`: ADDED requirement — core exports a `secrets-crypto` subpath providing `sealManifest` + `unsealWorkflow`, owning the libsodium dependency. The existing "minimal dependencies" requirement is MODIFIED to reflect libsodium's addition.
- `workflow-secrets`: existing decryption requirements re-pointed at the new core import (no behavioural change for guests).

## Impact

- Affected code:
  - `packages/sdk/src/cli/cli.ts` — `build` subcommand body changes.
  - `packages/sdk/src/cli/build.ts` — JS-only writer.
  - `packages/sdk/src/cli/upload.ts` — calls `bundle`; no disk read.
  - `packages/sdk/src/cli/bundle.ts` — NEW.
  - `packages/sdk/src/cli/build-workflows.ts` — NEW (the core).
  - `packages/sdk/src/cli/seal.ts` — DELETED. HTTP helper (`fetchPublicKey`) splits into `seal-http.ts`; crypto moves to core.
  - `packages/sdk/src/plugin/` — DELETED.
  - `packages/sdk/package.json` — drops `libsodium-wrappers`.
  - `packages/runtime/src/secrets/key-store.ts` — `decryptSealed` becomes a call to `unsealWorkflow` from core.
  - `packages/runtime/package.json` — drops `libsodium-wrappers`.
  - `packages/core/src/secrets/seal.ts` — NEW.
  - `packages/core/src/secrets/unseal.ts` — NEW.
  - `packages/core/package.json` — adds `libsodium-wrappers`; adds `./secrets-crypto` subpath in `exports`.
- Affected scripts / consumers:
  - `workflows/package.json` build script — invocation unchanged; output changes (no tarball, no manifest).
  - `scripts/dev.ts` — unchanged (still uses `upload`).
  - Any CI/tooling that greps for `dist/bundle.tar.gz` or `dist/manifest.json` after `pnpm build` — WILL break; must switch to `pnpm exec wfe upload` or call `bundle` programmatically. Need to grep the repo for residual references.
- APIs:
  - Internal: new `buildWorkflows`, `bundle`, `sealManifest`, `unsealWorkflow` exports.
  - External (server HTTP): unchanged.
  - Removed: `@workflow-engine/sdk/plugin` (no external consumers verified).
- Security:
  - Wire format unchanged (`crypto_box_seal` / X25519 / `secretsKeyId`). The single-home consolidation reduces drift risk between seal and unseal sides.
  - "No unsealed bundle on disk" is now an invariant: nothing in `dist/` ever contains `secretBindings` + sentinels.
- Dependencies: net-zero change at the monorepo level (libsodium-wrappers shifts from sdk + runtime → core).
