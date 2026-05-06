## Why

Today, authoring a workflow requires cloning the monorepo and running `pnpm exec wfe upload`. This blocks any third-party (e.g. a GitHub-org member with no checkout of this repo) from authoring against a hosted instance. To enable external authors, the SDK must be installable from npm, and the publish path must be wired into CI so what runs on prod and what's on npm can't drift.

## What Changes

- Publish `@workflow-engine/sdk` and `@workflow-engine/core` to npm as siblings. Sandbox stays workspace-only.
- Flip `@workflow-engine/core` from `private: true` to publishable; rewrite `exports` in both packages from `./src/*.ts` to `./dist/*.js` (+ `.d.ts`).
- Drop the `./sdk-support` entrypoint from the SDK's published `exports` map (server-only; runtime still imports it via the workspace source path).
- **BREAKING (wire format):** make `ManifestSchema` and its nested object schemas `.strict()`. Unknown fields now hard-fail at upload instead of being silently stripped. Existing bundles that emit only documented fields are unaffected.
- Adopt CalVer (`YYYY.MM.PATCH`) for sdk + core, lockstep. `package.json` `version` is permanently `0.0.0-dev` as a placeholder; CI computes the real version at publish time. Per-publish git tag `v$VERSION` anchors the source-change diff gate.
- Add a publish job to `.github/workflows/deploy-prod.yml`: on push to `release` under `environment: production`, gate on `git diff` of `packages/sdk` + `packages/core` since the last tag, compute CalVer, `pnpm pack` each package, `npm publish <tarball> --access public --provenance` per package in topological order, then `git push origin v$VERSION`. **Auth via npm trusted publishing (OIDC)** — no long-lived secret. The trusted-publisher binding on npmjs.com pins to this workflow path, the `release` branch, and `environment: production`.
- Bootstrap (one-time per package, manual operator action): npm trusted publishing cannot publish a package's first version (npm/cli#8544 unresolved). For each of `@workflow-engine/sdk` and `@workflow-engine/core`, the operator publishes a `0.0.0-init` placeholder via a temporary classic token, configures the trusted publisher, and deprecates the placeholder. After this, the temporary token is revoked and the automated CI flow takes over.
- Use `npm publish <tarball>` rather than `pnpm publish` for the publish step. `pnpm publish` does not reliably perform the OIDC token exchange against npm today (pnpm/pnpm#9812). `pnpm pack` is still used to produce the tarball (it correctly rewrites `workspace:*` to the concrete version).
- Add a PR-CI publish-shape smoke test: `pnpm pack` core + sdk, install both tarballs into a throwaway project outside the workspace, copy `workflows/src/demo.ts` into `src/`, run `wfe build`. Fails the PR if the published shape can't author the canonical demo.
- Add a PR-CI publish-dry-run gate: `npm publish --dry-run` on each packed tarball. Validates package.json metadata, files-array, and provenance prerequisites (e.g. `repository` field) from npm's client-side perspective without authenticating. Catches publish-shape errors before they reach the release-time job.
- Add a `repository` field to `packages/core/package.json` matching the GitHub repo. Required for `--provenance` validation; SDK already has it.
- Document the operational notes in `docs/infrastructure.md`: `AUTH_ALLOW` redeploy-per-invitee, the trusted-publisher rebinding procedure (if the workflow path or branch ever changes), `npm deprecate` for bad publishes, `read:org` PAT scope requirement.

## Capabilities

### New Capabilities
<!-- None — all changes land in existing capabilities. -->

### Modified Capabilities
- `ci-workflow`: Adds two requirements — a PR-time publish-shape smoke test (pack-and-install the SDK + core tarballs and build `demo.ts` against them), and a release-time publish job (compute CalVer from the last `v*` tag + diff, `pnpm -r publish` with provenance, push the new tag).
- `sdk`: Audience widens from "monorepo contributors using `pnpm exec wfe upload`" to "anyone with `npm i @workflow-engine/sdk`." Documents the install path, the `read:org` PAT scope requirement, and that `ManifestSchema` is now strict.

## Impact

- Source: `packages/core/package.json` (private→publishable, exports→dist), `packages/sdk/package.json` (exports→dist, drop `./sdk-support` from public exports), `packages/core/src/index.ts` (`.strict()` on `ManifestSchema` and nested object schemas).
- CI: `.github/workflows/deploy-prod.yml` gains a publish job (OIDC, no token); `.github/workflows/ci.yml` gains a smoke-test job that includes `npm publish --dry-run` against the packed tarballs.
- Docs: `docs/infrastructure.md` gains an SDK-publishing operations section.
- Secrets: **none required after bootstrap.** Trusted publishing eliminates the long-lived token. A short-lived classic token is needed only for the one-time bootstrap and is revoked immediately after.
- External: the `@workflow-engine` npm org is claimed (operator). Bootstrap (placeholder publish + trusted-publisher config) is required once per package before the automated flow takes over.
- Runtime behavior: unchanged. No sandbox, auth, persistence, or routing change. The `.strict()` flip is the only wire-format change and is forward-compat-safe (existing well-formed bundles unaffected).
- Out of scope: runtime-semantics forward compatibility (e.g. sandbox-stdlib precision changes between server versions). The manifest schema can't see these; mitigated by discipline, not this change.
