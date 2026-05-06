## 1. Make `@workflow-engine/core` publishable

- [x] 1.1 Flip `packages/core/package.json` `"private": true` → `false` (or remove the field)
- [x] 1.2 Set `"version": "0.0.0-dev"` in `packages/core/package.json`
- [x] 1.3 Rewrite `exports` in `packages/core/package.json` to point at `./dist/*.js` and `./dist/*.d.ts` for every entrypoint (`.`, `./constants`, `./secrets-crypto`); remove `./test-utils` from the published `exports` (it's workspace-only). **Implementation note:** done via `publishConfig.exports` so workspace `vite-node` dev keeps resolving src/ while the published manifest points at dist/.
- [x] 1.4 Ensure `files` includes `dist/` and excludes test fixtures; verify `pnpm pack` output contains exactly the intended files
- [x] 1.5 Confirm `tsc --build` produces the expected `dist/*.js` + `dist/*.d.ts` shape; fix any tsconfig settings (e.g. `declaration: true`) if missing. **Note:** added `rootDir: "src"` and `exclude: ["src/**/*.test.ts"]` to tsconfig so dist is flat and tests don't ship.
- [x] 1.6 Add a `repository` field to `packages/core/package.json` matching the GitHub repo (`https://github.com/stefanhoelzl/workflow-engine.git`, `directory: "packages/core"`); SDK already has this — required for `--provenance`
- [x] 1.7 Add a `license` field to `packages/core/package.json` (matching SDK's `MIT`) if missing

## 2. Make `@workflow-engine/sdk` publishable

- [x] 2.1 Set `"version": "0.0.0-dev"` in `packages/sdk/package.json`
- [x] 2.2 Rewrite `exports` to point at `./dist/*.js` and `./dist/*.d.ts` for `.` and `./cli`; remove `./sdk-support` from the published `exports`. **Implementation note:** done via `publishConfig.exports`. Current package only exposes `.` and `./cli` (no `./plugin` — that entry was already removed in a prior change).
- [x] 2.3 Verify `bin.wfe` points at `./dist/cli/cli.js` and that the compiled file has a `#!/usr/bin/env node` shebang
- [x] 2.4 Confirm runtime `dependencies` block declares `@workflow-engine/core` as `workspace:*` (pnpm rewrites at publish time to the concrete version); verified in packed tarball — `@workflow-engine/core` becomes `"0.0.0-dev"`
- [x] 2.5 Verify `peerDependencies` (`typescript >=5.0.0`) is correct and that no peer deps leak into regular `dependencies`
- [x] 2.6 Verify `files` includes `dist/`; run `pnpm pack` and inspect tarball contents — dist only, no src, no tests

## 3. Make ManifestSchema strict

- [x] 3.1 Add `.strict()` to the outer `ManifestSchema` in `packages/core/src/index.ts`. **Implementation note:** used `z.strictObject({...})` (Zod v4 idiom) instead of `.strict()` chaining, which is cleaner for refined schemas.
- [x] 3.2 Add `.strict()` to `workflowManifestSchema`
- [x] 3.3 Add `.strict()` to `actionManifestSchema`, `queueManifestSchema`
- [x] 3.4 Add `.strict()` to `httpTriggerManifestSchema` and its nested `request` / `response` object schemas
- [x] 3.5 Add `.strict()` to `cronTriggerManifestSchema`, `manualTriggerManifestSchema`, `imapTriggerManifestSchema`, `wsTriggerManifestSchema`
- [x] 3.6 Add `.strict()` to `imapTriggerResultSchema`, `imapAddressSchema`, `imapMessageSchema` and any other `z.object` nested in trigger schemas (incl. attachments)
- [x] 3.7 Add unit tests in `packages/core/src/index.test.ts` covering each scenario in `workflow-manifest/spec.md` (5 new tests in a "strict-mode rejection" describe block); also updated 4 existing "strips ..." tests in core + 2 in `packages/sdk/src/index.test.ts` to assert rejection instead of stripping
- [x] 3.8 Add an integration test in the runtime upload route that confirms a manifest with an unknown field returns 422 with the Zod-reported issues. **Implementation note:** added at `registerOwner` boundary (`packages/runtime/src/workflow-registry.test.ts`) which is the same parser path the upload route uses.
- [x] 3.9 Verify `pnpm test`, `pnpm check`, `pnpm lint` all pass after the schema change

## 4. PR-time publish-shape smoke test

- [x] 4.1 Add a new job `smoke-publish-shape` to `.github/workflows/ci.yml` running on every PR (no path filter)
- [x] 4.2 Job steps: checkout, setup-node, setup-pnpm, `pnpm install --frozen-lockfile`, `pnpm -r build`
- [x] 4.3 Job steps: `pnpm pack` in `packages/core` and `packages/sdk`, capturing the tarball paths via step output
- [x] 4.4 Job steps: create a temp directory outside the workspace, `npm init -y`, `npm pkg set type=module`, `npm install <core-tarball> <sdk-tarball>` together. **Implementation note:** `type: module` is required because the SDK's typecheck path uses `module: NodeNext`; without it Node treats source as CommonJS and rejects `export const ...` (TS1287).
- [x] 4.5 Job steps: copy `workflows/src/demo.ts` into the temp project's `src/workflow.ts`, run `npx wfe build`, assert `dist/workflow.js` exists and is non-empty. Verified locally end-to-end.
- [x] 4.6 Job steps: run `npm publish --dry-run --tag dev --access public --provenance` against each packed tarball (core then sdk) from `$RUNNER_TEMP` (outside the workspace, to bypass the workspace's `devEngines.runtime` Node-version constraint); fail the job if either dry-run exits non-zero. `--tag dev` is required for the `0.0.0-dev` placeholder version (a prerelease); at real release time the version is CalVer and `--tag dev` is unnecessary.
- [ ] 4.7 Verify the job fails when an `exports` typo is introduced (operator validation, post-merge — intentionally break `exports` on a scratch branch and confirm red CI)
- [ ] 4.8 Verify the dry-run step fails when `repository` is removed from `packages/core/package.json` (operator validation, post-merge)
- [x] 4.9 Confirm the smoke-test job uses Node ≥ 22.14 and npm ≥ 11.5.1 — `setup-pnpm` composite uses Node 24; smoke job adds `npm install -g npm@latest` to ensure npm ≥ 11.5.1

## 5. Bootstrap (one-time per package, manual operator action)

These steps are required before the automated CI publish flow can work, because npm trusted publishing cannot publish a package's first version (npm/cli#8544). They are performed once per package by an operator with npm-org admin rights, then never again.

- [x] 5.0.1 Generated short-lived classic automation token (`wfe-bootstrap-*`, 7-day expiry) — kept inline in `$NPM_TOKEN`, never written to repo secrets
- [x] 5.0.2 Authenticated via inline `--//registry.npmjs.org/:_authToken=$NPM_TOKEN` flag on each command (no persistent `npm login`)
- [x] 5.0.3 Published `@workflow-engine/core@0.0.0-init` placeholder with `--tag init` from `/tmp/wfe-bootstrap-core/`
- [x] 5.0.4 Configured trusted publisher for `@workflow-engine/core` on npmjs.com: repo `stefanhoelzl/workflow-engine`, workflow `deploy-prod.yml`, environment `production`
- [x] 5.0.5 Deprecated `@workflow-engine/core@0.0.0-init` with message "placeholder"
- [x] 5.0.6 Same for `@workflow-engine/sdk` — published, configured trusted publisher, deprecated. **Note:** the deprecate via classic token was blocked because adding a trusted publisher enabled "disallow tokens" mode; resolved by deprecating via the npmjs.com web UI session instead. Documented as a likely gotcha.
- [x] 5.0.7 Revoked the temporary classic token in the npm UI; `unset NPM_TOKEN` from local shell
- [x] 5.0.8 Bootstrap procedure documented in `docs/infrastructure.md` under "SDK publishing to npm" → "Bootstrap"

**Known caveat (post-bootstrap state):** npm sets `latest` automatically on first publish even with `--tag init`, so `dist-tags` for both packages currently shows `latest: 0.0.0-init`. The deprecation warning fires loudly on install. The first real CalVer publish (`2026.5.0`) will move `latest` to the real version. Acceptable until then.

## 6. Release-time publish job

- [x] 6.1 Add a new job `publish-npm` to `.github/workflows/deploy-prod.yml` running on push to `release`, under `environment: production`, with `permissions: contents: write` (for the tag push) and `id-token: write` (for OIDC + `--provenance`). No `NODE_AUTH_TOKEN` needed.
- [x] 6.2 Job step: checkout with `fetch-depth: 0` so `git describe` sees tags
- [x] 6.3 Job step: setup-node ≥ 22.14, setup-pnpm; ensure npm ≥ 11.5.1 via `npm install -g npm@latest`
- [x] 6.4 Job step: `pnpm install --frozen-lockfile`, `pnpm -r build` (inherits from setup-pnpm composite)
- [x] 6.5 Job step: compute `LAST_TAG` via `git describe --tags --match 'v*' --abbrev=0` (handle no-tag case with empty string → treat as initial publish)
- [x] 6.6 Job step: `git diff --name-only $LAST_TAG..HEAD -- packages/sdk packages/core`; if empty, set step output `skip=true` and bypass remaining steps via `if:` guards
- [x] 6.7 Job step: compute next CalVer per the bump rule in design.md (query `npm view @workflow-engine/sdk version`, bump patch if same UTC YYYY.M, else reset). Verified locally — produces `2026.5.0` on first publish.
- [x] 6.8 Job step: rewrite `version` in `packages/core/package.json` and `packages/sdk/package.json` in-place to `$NEXT` via `npm pkg set` (not committed)
- [x] 6.9 Job step: `pnpm --filter @workflow-engine/core pack` then `pnpm --filter @workflow-engine/sdk pack` to produce tarballs (`workspace:*` rewritten to `$NEXT`). Verified locally.
- [x] 6.10 Job step: `npm publish <core-tarball> --access public --provenance` then `npm publish <sdk-tarball> --access public --provenance` (order matters: core before sdk). Run from `$RUNNER_TEMP` to bypass workspace `devEngines` constraint. Authentication is via OIDC trusted publishing — no token env var.
- [x] 6.11 Job step: `git tag v$NEXT && git push origin v$NEXT` with bot identity
- [x] 6.12 Publish job is independent of `deploy` job — both run in parallel under `jobs:` with no `needs:` between them; failure of one does not affect the other
- [ ] 6.13 Manually rehearse the publish flow on a scratch branch (operator action; cannot be done from this PR — requires the trusted-publisher binding from task group 5 to be in place first)

## 7. Documentation

- [x] 7.1 Add an SDK-publishing operations section to `docs/infrastructure.md` covering: the bootstrap procedure, the trusted-publisher rebinding procedure, `npm deprecate` for bad publishes, CalVer bump rule
- [x] 7.2 Add a `AUTH_ALLOW` redeploy-per-invitee note to `docs/infrastructure.md` documenting the operator workflow for granting a new GitHub org/user access (incl. `read:org` PAT scope requirement)
- [x] 7.3 No README changes in `packages/sdk/` or `packages/core/` for v1 (intentionally out of scope per proposal)

## 8. End-to-end verification (pre-merge)

- [x] 8.1 `pnpm validate` runs green: lint, check, test (1477 passed), tofu fmt, tofu validate
- [ ] 8.2 Confirm the new smoke-test job passes on the PR — verifiable only after pushing the branch and opening a PR; locally simulated end-to-end (pack → install tarballs in temp project → wfe build → dist/workflow.js produced; npm publish --dry-run succeeds for both packages)
- [ ] 8.3 Operator dry-run on a scratch branch via `workflow_dispatch` — operator action; cannot run from this PR because trusted-publisher binding (task group 5) must be configured on npmjs.com first
