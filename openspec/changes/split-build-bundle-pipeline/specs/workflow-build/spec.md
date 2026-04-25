## MODIFIED Requirements

### Requirement: Root build includes workflows

The root `pnpm build` script SHALL build the runtime and SHALL produce per-workflow JS files but SHALL NOT produce `workflows/dist/bundle.tar.gz` or `workflows/dist/manifest.json`. Producing a deployable tenant tarball requires sealing, which is only available via `wfe upload` (which calls the internal `bundle` function) because sealing needs the server public key.

#### Scenario: Full build

- **WHEN** `pnpm build` is run from the repository root
- **THEN** `dist/main.js` (runtime) SHALL be produced
- **AND** each declared workflow SHALL have a corresponding `workflows/dist/<name>.js` file produced
- **AND** `workflows/dist/bundle.tar.gz` SHALL NOT be produced
- **AND** `workflows/dist/manifest.json` SHALL NOT be produced

#### Scenario: Deployable tarball requires upload path

- **WHEN** a deployable tenant tarball is needed
- **THEN** it SHALL be produced by `wfe upload` (or the internal `bundle` function it calls)
- **AND** it SHALL NOT be produced as a side effect of `pnpm build`
- **AND** it SHALL NOT be written to disk at any point in the upload pipeline

## REMOVED Requirements

### Requirement: Vite plugin builds workflows into a single tenant tarball

**Reason**: The public `@workflow-engine/sdk/plugin` export and `packages/sdk/src/plugin/` directory are deleted. Workflow discovery + per-workflow Vite/Rolldown sub-builds move into the in-memory `buildWorkflows` core in the SDK CLI. Empirically nothing in the monorepo imports the plugin from outside the SDK package itself, and the `cli` capability already forbids user-authored `vite.config.ts`. Continuing to expose a plugin would either preserve the prohibited disk-writes-an-unsealed-tarball behaviour or stand as a public surface with no consumers and a foot-gun (CI cache, ad-hoc invocation) that produces undeployable artefacts.

**Migration**: Code that previously composed `workflowPlugin` into a custom Vite config SHALL switch to invoking `wfe build` (for JS-only) or `wfe upload` (for the deployable sealed pipeline). Programmatic consumers SHALL import `buildWorkflows` (JS-only) or `bundle` (sealed) from `@workflow-engine/sdk/cli`.
