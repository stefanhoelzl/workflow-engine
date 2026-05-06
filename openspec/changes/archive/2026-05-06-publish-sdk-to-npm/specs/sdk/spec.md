## ADDED Requirements

### Requirement: SDK is installable from the npm registry

The `@workflow-engine/sdk` package SHALL be installable via `npm install @workflow-engine/sdk` (or pnpm/yarn equivalents) from the public npm registry. After install, `npx wfe` SHALL invoke the `wfe` CLI from the installed package.

The package's `exports` field SHALL point at compiled JavaScript and TypeScript declaration files under `dist/`, not at TypeScript source under `src/`. The `files` field SHALL include `dist/` and any other artifacts required at install time.

The package's runtime dependencies SHALL NOT contain any `workspace:*` references in the published tarball. `pnpm publish` SHALL rewrite `workspace:*` to the concrete version of `@workflow-engine/core` published in the same job run.

The published `exports` map SHALL NOT include the `./sdk-support` entrypoint. `sdk-support` is a runtime-internal sandbox plugin module consumed via a workspace-relative path; it is not part of the author-facing surface.

#### Scenario: External author installs and uploads

- **GIVEN** an empty project with `package.json` and a `src/workflow.ts` that imports `defineWorkflow` from `@workflow-engine/sdk`
- **WHEN** the author runs `npm install @workflow-engine/sdk` followed by `npx wfe upload --owner <org> --token <PAT-with-read:org>`
- **THEN** the SDK SHALL build and upload the workflow against the configured runtime URL
- **AND** SHALL not require a checkout of the workflow-engine monorepo

#### Scenario: Published tarball contains compiled output, not source

- **WHEN** `npm pack @workflow-engine/sdk` is inspected
- **THEN** the tarball SHALL contain `dist/*.js` and `dist/*.d.ts` files
- **AND** the `exports` map SHALL resolve every entrypoint to a file under `dist/`

#### Scenario: Published tarball has concrete @workflow-engine/core version

- **WHEN** `npm view @workflow-engine/sdk dependencies` is inspected for any published version
- **THEN** the `@workflow-engine/core` dep SHALL be a concrete version string (e.g. `2026.5.1`)
- **AND** SHALL NOT be `workspace:*` or any non-resolvable specifier

#### Scenario: sdk-support is not exposed via the published exports map

- **WHEN** an external consumer attempts to import `@workflow-engine/sdk/sdk-support`
- **THEN** Node module resolution SHALL fail with no matching `exports` entry

### Requirement: `@workflow-engine/core` is published as a sibling

The `@workflow-engine/core` package SHALL be published to the npm registry alongside `@workflow-engine/sdk`. Its `package.json` SHALL declare `"private": false` (or omit the field) at publish time, with `exports` pointing at compiled output under `dist/`. The runtime continues to consume it via `workspace:*`; only the published artifact is materially affected.

The `@workflow-engine/sdk` package SHALL list `@workflow-engine/core` as a regular runtime dependency (not a peer dependency, not a dev dependency).

#### Scenario: core is published with sdk

- **WHEN** the publish job runs successfully for any version `$VERSION`
- **THEN** `@workflow-engine/core@$VERSION` SHALL be resolvable from the npm registry
- **AND** SHALL contain `dist/*.js` and `dist/*.d.ts` for every entrypoint declared in its `exports` map

### Requirement: Both packages declare a repository field for provenance

`@workflow-engine/sdk` and `@workflow-engine/core` SHALL each declare a `repository` field in their `package.json` matching the GitHub repository URL `https://github.com/stefanhoelzl/workflow-engine.git` (with the appropriate `directory` subpath). npm's `--provenance` validation rejects publishes whose `repository` does not match the GitHub Actions workflow's repository — without this field, the release publish job fails.

#### Scenario: Both packages have repository field at publish time

- **WHEN** the publish job invokes `npm publish --provenance` on either tarball
- **THEN** the tarball's `package.json` SHALL contain a `repository` field whose `url` resolves to the same GitHub repository as the workflow's `${{ github.repository }}`
- **AND** provenance validation SHALL succeed

### Requirement: Authoring requires a GitHub PAT with `read:org` scope

External authors uploading to a hosted runtime via `wfe upload --token <PAT>` SHALL provide a GitHub personal access token with the `read:org` scope (or, for fine-grained tokens, "Members: read" on the target organization).

The runtime authenticates the upload by calling GitHub's `/user` and `/user/orgs` endpoints to populate `user.orgs`, then enforcing `isMember(user, owner)` against the `AUTH_ALLOW` set. A token without `read:org` SHALL produce an empty `user.orgs`, causing the membership check to fail and the upload to receive a 404 response.

#### Scenario: Token without read:org fails membership check

- **GIVEN** a PAT scoped only to `repo` (no `read:org`)
- **WHEN** the author runs `wfe upload --owner <org> --token <PAT>`
- **THEN** the runtime SHALL respond with 404
- **AND** the response body SHALL not disclose whether the owner exists
