## ADDED Requirements

### Requirement: SDK ships a comprehensive, documented example workflow

The `@workflow-engine/sdk` package SHALL ship a single example workflow file (`example.ts`) in its published npm tarball (listed in `package.json` `files`). The example SHALL exercise every author-facing SDK surface: all trigger kinds (`httpTrigger`, `cronTrigger`, `manualTrigger`, `imapTrigger`, `wsTrigger`), `action` composition, `defineWorkflow`/`env`, `secret`, `defineQueue`, `executeSql`, `sendMail`, and the sandbox-stdlib globals. Each surface SHALL carry an explanatory doc-comment. The example is the canonical full-surface authoring reference: a change that adds or alters an author-facing SDK surface SHALL update `example.ts` in the same change.

#### Scenario: Example ships in the tarball

- **WHEN** `@workflow-engine/sdk` is packed (`npm pack`)
- **THEN** the tarball contains `example.ts`
- **AND** it is fetchable at `unpkg.com/@workflow-engine/sdk@<version>/example.ts`

#### Scenario: Example covers every author-facing surface

- **WHEN** `example.ts` is inspected
- **THEN** it references every trigger kind, `action` composition, `env`, `secret`, `defineQueue`, `executeSql`, `sendMail`, and at least one sandbox-stdlib global

#### Scenario: New SDK surface requires updating the example

- **WHEN** a change adds or alters an author-facing SDK export
- **AND** it does not update `example.ts`
- **THEN** the change is incomplete per this requirement

### Requirement: SDK ships an agent-facing README

The `@workflow-engine/sdk` package SHALL ship a `README.md` in its published tarball whose content orients an agent authoring and deploying a workflow: minimal project bootstrapping (`package.json`, install), the `wfe build` and `wfe upload` commands, the CI deploy path, and the non-code gotchas. The README SHALL explicitly document that `wfe build` enforces its own strict TypeScript options and ignores the user's `tsconfig.json`, so a lax editor config can pass locally yet fail the build.

#### Scenario: README ships and is non-trivial

- **WHEN** `@workflow-engine/sdk` is packed
- **THEN** the tarball contains a `README.md` whose content covers bootstrapping, `wfe build`/`wfe upload`, and the deploy path

#### Scenario: README documents the tsconfig-ignored gotcha

- **WHEN** the README is inspected
- **THEN** it states that `wfe build` uses its own strict compiler options and does not read the user's `tsconfig.json`

### Requirement: Every SDK export carries TSDoc

Every author-facing value export of `@workflow-engine/sdk` SHALL carry a TSDoc doc-comment stating the symbol's purpose in one line and either an `@example` or a pointer to `example.ts`. The doc-comments SHALL ship in the generated `.d.ts` so they surface on LSP hover and completion without any opt-in.

#### Scenario: Each export is documented

- **WHEN** the SDK entry module is inspected
- **THEN** each author-facing value export has a preceding TSDoc doc-comment

#### Scenario: TSDoc ships in the type declarations

- **WHEN** `@workflow-engine/sdk` is built for publish
- **THEN** the emitted `.d.ts` retains the export doc-comments

### Requirement: The runtime `/llms.txt` index advertises the version-matched docs

The document served at `/llms.txt` (route mechanics defined by the `http-server` and `http-security` capabilities) SHALL be a static text index that points agents at the SDK docs on unpkg resolved to `@latest`, and SHALL instruct an agent that already has the SDK installed to prefer its local `node_modules/@workflow-engine/sdk/` copy as the version-matched source. Its body SHALL be a fixed constant that does not reflect any request input.

#### Scenario: Index names the unpkg docs at latest

- **WHEN** `/llms.txt` is fetched
- **THEN** the body references the SDK docs under `unpkg.com/@workflow-engine/sdk@latest/`

#### Scenario: Index directs installed agents to node_modules

- **WHEN** `/llms.txt` is fetched
- **THEN** the body instructs an agent with the SDK installed to read its `node_modules/@workflow-engine/sdk/` copy

#### Scenario: Index body is a static constant

- **WHEN** two requests to `/llms.txt` are made with differing headers, query strings, and methods-that-reach-it
- **THEN** the returned body is byte-identical and contains no echoed request input
