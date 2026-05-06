## ADDED Requirements

### Requirement: PR publish-shape smoke test

The PR validation workflow SHALL include a job that exercises the SDK + core publish artifacts against `workflows/src/demo.ts`. The job SHALL run on every PR (no path filter).

The job SHALL:

1. Install workspace dependencies and run `pnpm -r build`.
2. Run `pnpm pack` in `packages/core` and `packages/sdk` to produce `.tgz` tarballs identical in shape to what `pnpm publish` would upload (including the `workspace:*` → concrete-version rewrite).
3. Create a temporary project directory outside the workspace and run `npm init -y`.
4. Install both tarballs together via `npm install <core-tarball> <sdk-tarball>`, so the SDK's `@workflow-engine/core` dependency resolves to the local tarball rather than the npm registry.
5. Copy `workflows/src/demo.ts` into the temporary project's `src/` directory.
6. Run `npx wfe build` from the temporary project.
7. Assert that `dist/demo.js` exists and is non-empty.

After the consumer-side build assertion, the job SHALL additionally invoke `npm publish --dry-run --access public --provenance` against each packed tarball. The dry-run SHALL NOT authenticate to or contact the npm registry; its purpose is to validate the publish-shape from npm's client-side perspective (package.json metadata, files-array completeness, presence of `repository` for provenance, scoped-package access settings, `bin` path resolution against the tarball, SPDX license validity). Either dry-run failing SHALL fail the PR.

The job SHALL fail the PR if any step fails. The job's purpose is to detect failure modes that the workspace's symlinked `workspace:*` resolution hides — `exports` map errors, missing `dist/` files, leaked `workspace:*` deps, missing executable bits on `wfe`, undeclared peer dependencies, `.d.ts` references to workspace-internal paths, and publish-shape errors that would surface only at the release-time publish.

#### Scenario: Smoke test passes for canonical demo

- **GIVEN** a PR whose changes preserve the SDK's published shape
- **WHEN** the smoke-test job runs
- **THEN** all steps SHALL succeed
- **AND** `dist/demo.js` SHALL exist in the temporary project after `npx wfe build`

#### Scenario: Broken `exports` map fails the smoke test

- **GIVEN** a PR that introduces a typo in `packages/sdk/package.json` `exports` (e.g. points at `./dis/index.js`)
- **WHEN** the smoke-test job's `npm install` and `npx wfe build` steps run
- **THEN** module resolution from the temporary project SHALL fail
- **AND** the job SHALL exit non-zero

#### Scenario: Leaked workspace dep fails the smoke test

- **GIVEN** a PR that adds a `workspace:*` dep to `packages/sdk/package.json` for a package that is not in the publish set
- **WHEN** the smoke-test job's `npm install` step runs
- **THEN** npm SHALL fail to resolve the dep
- **AND** the job SHALL exit non-zero

#### Scenario: Smoke test runs on unrelated PRs

- **GIVEN** a PR whose changes do not touch `packages/sdk`, `packages/core`, or `workflows/`
- **WHEN** the PR validation workflow runs
- **THEN** the smoke-test job SHALL still execute (no path filter)

#### Scenario: Publish dry-run rejects missing repository field

- **GIVEN** a PR whose changes remove the `repository` field from `packages/core/package.json`
- **WHEN** the smoke-test job's `npm publish --dry-run --provenance` step runs against the core tarball
- **THEN** the dry-run SHALL exit non-zero
- **AND** the job SHALL fail the PR

#### Scenario: Publish dry-run rejects malformed package metadata

- **GIVEN** a PR that introduces an invalid SPDX license identifier or a `files` entry referencing a non-existent path
- **WHEN** the smoke-test job's `npm publish --dry-run` step runs
- **THEN** the dry-run SHALL exit non-zero with a message naming the offending field
- **AND** the job SHALL fail the PR

#### Scenario: Publish dry-run does not authenticate

- **WHEN** the smoke-test job's `npm publish --dry-run` step runs
- **THEN** the step SHALL NOT contact the npm registry for authentication
- **AND** SHALL succeed without `NODE_AUTH_TOKEN` or any OIDC token exchange
- **AND** SHALL run identically on PRs from forks (which have no access to repo secrets or the production environment)

### Requirement: Release publish job to npm

The prod deploy workflow (push to the `release` branch) SHALL include a job that publishes `@workflow-engine/core` and `@workflow-engine/sdk` to npm in lockstep when their source has changed since the last published tag. The job SHALL run on the same workflow event as the prod image push, under `environment: production`, and SHALL NOT block or be blocked by the image push.

The job SHALL execute the following steps in order:

1. Checkout (with `fetch-depth: 0` so `git describe` sees tags), setup-node ≥ 22.14, setup-pnpm, `pnpm install --frozen-lockfile`, `pnpm -r build`.
2. Locate the most recent annotated/lightweight tag matching `v*` via `git describe --tags --match 'v*' --abbrev=0`. If none exists, treat it as the empty range (publish unconditionally).
3. Run `git diff --name-only $LAST_TAG..HEAD -- packages/sdk packages/core`.
4. **If the diff is empty**, the job SHALL exit successfully without publishing or tagging.
5. **If the diff is non-empty**, the job SHALL compute the next CalVer version by querying `npm view @workflow-engine/sdk version` and applying the rule: `if latest is YYYY.M.PATCH and matches the current UTC year+month, increment PATCH; otherwise reset to YYYY.M.0`.
6. Rewrite the `version` field in `packages/core/package.json` and `packages/sdk/package.json` to the computed value (in-place, not committed back to the branch).
7. Run `pnpm --filter @workflow-engine/core pack` and `pnpm --filter @workflow-engine/sdk pack` to produce tarballs with `workspace:*` rewritten to the computed concrete version.
8. Run `npm publish <core-tarball> --access public --provenance`, then `npm publish <sdk-tarball> --access public --provenance`. The order matters: sdk's tarball references core@$VERSION, so core MUST be on the registry before sdk is published.
9. Tag the current commit `v$VERSION` and push the tag to origin.

The job SHALL authenticate to npm using **trusted publishing (OIDC)** — no `NODE_AUTH_TOKEN`, no static credential. Each package's trusted-publisher binding on npmjs.com SHALL pin to the repository `stefanhoelzl/workflow-engine`, the workflow file `.github/workflows/deploy-prod.yml`, the `release` branch, and the `production` GitHub Actions environment. The job SHALL declare `permissions: id-token: write` (for OIDC + provenance) and `permissions: contents: write` (for the tag push).

The publish step SHALL use `npm publish <tarball>` rather than `pnpm publish`, because `pnpm publish` does not reliably perform the OIDC token exchange against npm 11.5.1+ on GitHub-hosted runners (pnpm/pnpm#9812). `pnpm pack` is used for tarball generation; `npm publish` is used for the actual publish.

#### Scenario: First publish creates initial version

- **GIVEN** the repository has no `v*` git tag yet
- **AND** push to `release` includes changes under `packages/sdk` or `packages/core`
- **WHEN** the publish job runs
- **THEN** it SHALL compute the version as `<UTC-YEAR>.<UTC-MONTH>.0`
- **AND** publish both packages with that version
- **AND** push the tag `v<UTC-YEAR>.<UTC-MONTH>.0`

#### Scenario: Subsequent publish in the same calendar month bumps patch

- **GIVEN** the latest published version is `2026.5.0`
- **AND** the most recent `v*` tag is `v2026.5.0`
- **AND** the current UTC date is in May 2026
- **AND** push to `release` includes changes under `packages/sdk` or `packages/core` since `v2026.5.0`
- **WHEN** the publish job runs
- **THEN** it SHALL publish version `2026.5.1`
- **AND** push the tag `v2026.5.1`

#### Scenario: First publish in a new calendar month resets patch

- **GIVEN** the latest published version is `2026.5.3`
- **AND** the current UTC date is in June 2026
- **AND** push to `release` includes changes under `packages/sdk` or `packages/core` since `v2026.5.3`
- **WHEN** the publish job runs
- **THEN** it SHALL publish version `2026.6.0`
- **AND** push the tag `v2026.6.0`

#### Scenario: Push to release with no SDK or core changes does not publish

- **GIVEN** the most recent `v*` tag is `v2026.5.1`
- **AND** push to `release` contains only changes under `packages/runtime`, `infrastructure/`, or other non-publishable paths
- **WHEN** the publish job runs
- **THEN** the job SHALL exit successfully
- **AND** SHALL NOT publish to npm
- **AND** SHALL NOT push a new tag

#### Scenario: Publish authentication via trusted publishing

- **WHEN** the publish job invokes `npm publish` against either tarball
- **THEN** authentication SHALL use npm trusted publishing — the GitHub Actions OIDC token, exchanged with npm at publish time
- **AND** the job SHALL NOT use `NODE_AUTH_TOKEN` or any other long-lived credential
- **AND** the workflow's `permissions` block SHALL include `id-token: write` and `contents: write`
- **AND** the job SHALL run under `environment: production`
- **AND** the published tarballs SHALL carry sigstore provenance attestations linking them to the GitHub Actions run and commit SHA

#### Scenario: Publish step uses npm publish on packed tarballs

- **WHEN** the publish job reaches the publish step
- **THEN** it SHALL invoke `npm publish <tarball> --access public --provenance` once per package, in the order core then sdk
- **AND** SHALL NOT invoke `pnpm publish` or `pnpm -r publish`
- **AND** the tarballs SHALL have been produced by `pnpm pack` (which performs the `workspace:*` → concrete-version rewrite)

#### Scenario: Trusted publisher binding rejects publish from a different workflow

- **GIVEN** a malicious or accidental new workflow file at `.github/workflows/other.yml` that attempts `npm publish` against either package
- **WHEN** that workflow runs (even on the `release` branch with `id-token: write`)
- **THEN** npm's trusted-publisher check SHALL reject the publish because the workflow path does not match the binding
- **AND** the publish SHALL fail with a clear error

#### Scenario: Lockstep versioning of sdk and core

- **WHEN** the publish job publishes any version `$VERSION`
- **THEN** both `@workflow-engine/core@$VERSION` and `@workflow-engine/sdk@$VERSION` SHALL be published in the same job run
- **AND** the SDK's published tarball SHALL declare its `@workflow-engine/core` dependency as `$VERSION` (not `workspace:*`)
