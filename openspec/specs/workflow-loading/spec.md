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

The loader SHALL read and parse `manifest.json` from each workflow subdirectory using the SDK's `ManifestSchema` for validation. Event schemas SHALL be reconstructed from JSON Schema via `z.fromJSONSchema()`. Action source code SHALL be read from individual source files specified by each action's `module` field in the manifest. Each loaded action SHALL carry its `source: string` (the file contents) and `env: Record<string, string>` from the manifest.

#### Scenario: Valid manifest and action source files

- **WHEN** a subdirectory contains a valid `manifest.json` with actions having `module: "./handleCronitorEvent.js"` and `env: { "API_KEY": "value" }`
- **THEN** the loader SHALL parse the manifest, reconstruct Zod schemas for each event, read each action's source file as a string via `readFile`, and produce `Action` objects with `source` and `env` fields
- **AND** each loaded `Action` object SHALL include its `source: string` (the file contents) and `env: Record<string, string>` from the manifest

#### Scenario: Manifest fails validation

- **WHEN** a `manifest.json` fails `ManifestSchema` parsing
- **THEN** the loader SHALL log a warning with the directory name and validation error
- **AND** the loader SHALL skip that workflow and continue loading remaining workflows

#### Scenario: Action source file fails to read

- **WHEN** `manifest.json` is valid but an action's source file specified by `module` cannot be read
- **THEN** the loader SHALL log a warning and skip that workflow

#### Scenario: Action type is source string not function

- **WHEN** the loader produces an `Action` object
- **THEN** the `Action` SHALL have `source: string` containing the JavaScript source code
- **AND** the `Action` SHALL NOT have a `handler` function reference

### Requirement: Merge loaded workflows into shared registries
The runtime SHALL merge triggers from all loaded workflows into a single `HttpTriggerRegistry` and combine all actions into a single actions list. Event schemas from all manifests SHALL be merged into a single event schema registry.

#### Scenario: Two workflows with distinct trigger paths
- **WHEN** workflow A registers trigger path `cronitor` and workflow B registers trigger path `alerts`
- **THEN** both triggers SHALL be available in the shared registry

#### Scenario: Duplicate trigger paths across workflows
- **WHEN** two workflows register the same trigger path and HTTP method
- **THEN** the runtime SHALL fail at startup with an error identifying the conflicting path

### Requirement: Loaded workflows participate in dispatch
All actions from loaded workflows SHALL be included in the scheduler's fan-out logic. The scheduler SHALL pass each action's `env` to the context factory when creating `ActionContext` for that action.

#### Scenario: Event matches actions from different workflows
- **WHEN** an event type matches actions from two different loaded workflows
- **THEN** the scheduler SHALL emit targeted events for all matching actions

#### Scenario: Action receives its declared env
- **GIVEN** an action loaded with `env: { "API_KEY": "secret", "BASE_URL": "https://example.com" }`
- **WHEN** the scheduler executes that action
- **THEN** the `ActionContext` SHALL have `env` set to `{ "API_KEY": "secret", "BASE_URL": "https://example.com" }`
