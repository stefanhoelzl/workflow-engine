## ADDED Requirements

### Requirement: Per-workflow bundle output

The build SHALL produce one bundled JS module per workflow file. The bundle SHALL contain all action handlers, the trigger handler(s), and module-scoped imports/constants as named exports under their original names.

#### Scenario: Single bundle per workflow

- **GIVEN** a workflow file `cronitor.ts` with two actions and one trigger
- **WHEN** the build runs
- **THEN** the build SHALL produce exactly one JS bundle `dist/cronitor/cronitor.js`
- **AND** the bundle SHALL export each action and the trigger by their original export names

#### Scenario: Bundle includes module-scoped npm imports

- **GIVEN** a handler importing `format` from `date-fns`
- **WHEN** the build runs
- **THEN** the bundle SHALL inline the `format` function

### Requirement: Build emits manifest alongside bundle

For each workflow, the build SHALL emit `dist/<name>/manifest.json` and `dist/<name>/<name>.js`. The manifest format follows the `workflow-manifest` capability spec.

#### Scenario: Manifest and bundle in same directory

- **GIVEN** a workflow named `cronitor`
- **WHEN** the build runs
- **THEN** `dist/cronitor/manifest.json` and `dist/cronitor/cronitor.js` SHALL both exist

## REMOVED Requirements

### Requirement: Per-action bundle output

**Reason**: Per-action bundles do not match the new one-sandbox-per-workflow model. A single bundle per workflow loads once into the workflow's sandbox; nested action calls dispatch within the same context.

**Migration**: Build consumers expecting per-action `.js` files SHALL look for the per-workflow bundle and load it once.
