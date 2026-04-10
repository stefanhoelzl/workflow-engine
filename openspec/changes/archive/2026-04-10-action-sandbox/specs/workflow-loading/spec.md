## MODIFIED Requirements

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
