## MODIFIED Requirements

### Requirement: Build step

The workflow SHALL run `pnpm build` to produce the production build via Vite. `pnpm build` is aliased to `pnpm -r build`, which SHALL include the `workflows` workspace's bundle build (`wfe build`). `workflows/src/demo.ts` is the runnable-subset dev fixture and SHALL continue to build; a failure to build it SHALL fail the PR validation workflow. Full-surface coverage is validated separately by the example-workflow bundle gate defined below, not by `demo.ts`.

#### Scenario: Build succeeds

- **WHEN** every workspace's build (including the `workflows` bundle build) completes without errors
- **THEN** the step SHALL succeed and the workflow SHALL report success

#### Scenario: Build fails

- **WHEN** any workspace's build fails (including a regression that breaks `workflows/src/demo.ts`)
- **THEN** the step SHALL fail and the workflow SHALL report failure

#### Scenario: Workflow bundle build is covered

- **GIVEN** `workflows/package.json` declares `"build": "wfe build"`
- **WHEN** the CI build step runs `pnpm build`
- **THEN** the `workflows` bundle build SHALL be invoked as part of the recursive workspace build
- **AND** a broken demo.ts SHALL cause the step to exit non-zero

## ADDED Requirements

### Requirement: Example workflow bundle validation

The PR validation workflow SHALL bundle-validate the SDK's `example.ts` — typecheck plus bundle via `wfe build`, with no upload — so that the shipped full-surface example is proven to compile against the real SDK types on every PR. Because bundling never executes handlers, the gate SHALL cover infra-only trigger kinds (`imapTrigger`, `wsTrigger`) that cannot run in local dev. A broken `example.ts` SHALL fail the workflow.

#### Scenario: Example is bundled, not uploaded

- **WHEN** the CI example-validation step runs
- **THEN** it invokes `wfe build` against `example.ts`
- **AND** it does NOT invoke `wfe upload` or otherwise deploy the example

#### Scenario: Broken example fails the workflow

- **WHEN** `example.ts` no longer typechecks or bundles against the current SDK surface
- **THEN** the step SHALL exit non-zero and the workflow SHALL report failure

#### Scenario: Infra-only triggers are covered by the bundle

- **GIVEN** `example.ts` declares `imapTrigger` and `wsTrigger` handlers
- **WHEN** the example-validation step runs
- **THEN** the bundle SHALL succeed without any mail server or WebSocket client, validating those surfaces at compile time
