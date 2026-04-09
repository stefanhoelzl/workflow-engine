## MODIFIED Requirements

### Requirement: Dynamic workflow discovery from directory
The runtime SHALL scan the directory specified by `WORKFLOW_DIR` for subdirectories containing a `manifest.json` file at startup.

#### Scenario: Directory contains workflow subdirectories
- **WHEN** `WORKFLOW_DIR` points to a directory containing `cronitor/manifest.json` and `alerts/manifest.json`
- **THEN** the loader SHALL attempt to load both workflows

#### Scenario: Directory is empty
- **WHEN** `WORKFLOW_DIR` points to an empty directory
- **THEN** the runtime SHALL start normally with no workflows loaded

#### Scenario: Directory contains non-workflow entries
- **WHEN** `WORKFLOW_DIR` contains `cronitor/manifest.json` and a file `README.md` at the top level
- **THEN** the loader SHALL only attempt to load the `cronitor` workflow

### Requirement: Manifest-based workflow loading
The loader SHALL read and parse `manifest.json` from each workflow subdirectory using the SDK's `ManifestSchema` for validation. Event schemas SHALL be reconstructed from JSON Schema via `z.fromJSONSchema()`. Handler functions SHALL be imported from the actions module specified by the manifest's `module` field.

#### Scenario: Valid manifest and actions module
- **WHEN** a subdirectory contains a valid `manifest.json` and a matching `actions.js`
- **THEN** the loader SHALL parse the manifest, reconstruct Zod schemas for each event, import the actions module, and match named exports to action entries via the `handler` field

#### Scenario: Manifest fails validation
- **WHEN** a `manifest.json` fails `ManifestSchema` parsing
- **THEN** the loader SHALL log a warning with the directory name and validation error
- **AND** the loader SHALL skip that workflow and continue loading remaining workflows

#### Scenario: Actions module fails to import
- **WHEN** `manifest.json` is valid but the actions module specified by `module` cannot be imported
- **THEN** the loader SHALL log a warning and skip that workflow

#### Scenario: Handler export missing
- **WHEN** `manifest.json` lists an action with `handler: "processEvent"` but the actions module has no export named `processEvent`
- **THEN** the loader SHALL log a warning and skip that workflow

### Requirement: Merge loaded workflows into shared registries
The runtime SHALL merge triggers from all loaded workflows into a single `HttpTriggerRegistry` and combine all actions into a single actions list. Event schemas from all manifests SHALL be merged into a single event schema registry.

#### Scenario: Two workflows with distinct trigger paths
- **WHEN** workflow A registers trigger path `cronitor` and workflow B registers trigger path `alerts`
- **THEN** both triggers SHALL be available in the shared registry

#### Scenario: Duplicate trigger paths across workflows
- **WHEN** two workflows register the same trigger path and HTTP method
- **THEN** the runtime SHALL fail at startup with an error identifying the conflicting path

### Requirement: Loaded workflows participate in dispatch
All actions from loaded workflows SHALL be included in the scheduler's fan-out logic.

#### Scenario: Event matches actions from different workflows
- **WHEN** an event type matches actions from two different loaded workflows
- **THEN** the scheduler SHALL emit targeted events for all matching actions

## REMOVED Requirements

### Requirement: Dynamic import of workflow modules
**Reason**: Replaced by manifest-based loading. The runtime no longer imports `.js` files and reads their default export as `WorkflowConfig`.
**Migration**: Workflow files are now compiled by the Vite plugin into `manifest.json` + `actions.js` pairs. The runtime reads the manifest and imports the actions module separately.
