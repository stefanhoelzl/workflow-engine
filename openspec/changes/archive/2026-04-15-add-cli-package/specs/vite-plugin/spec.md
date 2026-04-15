## REMOVED Requirements

### Requirement: Plugin accepts explicit workflow list

**Reason**: Replaced by auto-discovery. The plugin no longer accepts a `workflows: string[]` option; all workflow entries are discovered from `<root>/src/*.ts`. The only in-tree caller (`workflows/vite.config.ts`) is deleted in this change.

**Migration**: Remove the `workflows: string[]` argument from `workflowPlugin(...)` calls; place each workflow at `<root>/src/<name>.ts`. User-authored `vite.config.ts` is no longer supported — the CLI ships its own default config, which is the only documented caller of the plugin.

## ADDED Requirements

### Requirement: Auto-discovery of workflow entry files

The `@workflow-engine/vite-plugin` SHALL auto-discover workflow entry files by globbing `<vite-root>/src/*.ts` non-recursively when the plugin is invoked with no options: `workflowPlugin()`. Each matched file becomes a workflow whose name is the file basename without the `.ts` extension.

The plugin SHALL NOT accept a `workflows: string[]` option. Callers MUST rely on auto-discovery.

#### Scenario: No options given, single workflow present

- **WHEN** `workflowPlugin()` is invoked and `<vite-root>/src/foo.ts` exists
- **THEN** the plugin SHALL treat `foo` as the sole workflow entry
- **AND** the build SHALL emit `dist/foo/bundle.tar.gz`

#### Scenario: No options given, multiple workflows present

- **WHEN** `workflowPlugin()` is invoked and `<vite-root>/src/` contains `foo.ts` and `bar.ts`
- **THEN** the plugin SHALL treat both as workflow entries
- **AND** the build SHALL emit `dist/foo/bundle.tar.gz` and `dist/bar/bundle.tar.gz`

#### Scenario: Files in nested directories are ignored

- **WHEN** `<vite-root>/src/` contains `foo.ts` and a subdirectory `shared/util.ts`
- **THEN** the plugin SHALL treat only `foo` as a workflow entry
- **AND** `util` SHALL NOT be treated as a workflow entry

### Requirement: Loud failure when src/ is empty or missing

The plugin SHALL fail the build loudly when the auto-discovery step finds no workflow entry files. The failure SHALL be reported via vite's plugin error mechanism with a message that names the expected directory.

#### Scenario: Missing src directory

- **WHEN** the plugin runs and `<vite-root>/src/` does not exist
- **THEN** the build SHALL fail with an error message that includes the text `no workflows found`
- **AND** the error message SHALL include the absolute path the plugin was looking at

#### Scenario: Empty src directory

- **WHEN** the plugin runs and `<vite-root>/src/` exists but has no `.ts` files at the top level
- **THEN** the build SHALL fail with an error message that includes the text `no workflows found`

### Requirement: Bundle artifact produced per workflow

For each discovered workflow `<name>`, the plugin SHALL emit a `<name>/bundle.tar.gz` artifact under the vite build output directory. The tar archive SHALL contain `manifest.json` and `actions.js` at its root. This `bundle.tar.gz` is the sole artifact consumed by downstream upload tooling (`@workflow-engine/cli`).

#### Scenario: Bundle contains manifest and action module

- **WHEN** the plugin successfully builds workflow `foo`
- **THEN** `dist/foo/bundle.tar.gz` SHALL unpack into files named `manifest.json` and `actions.js`
