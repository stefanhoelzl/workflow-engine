## ADDED Requirements

### Requirement: Dynamic workflow discovery from directory
The runtime SHALL scan the directory specified by `WORKFLOW_DIR` for all files with a `.js` extension at startup.

#### Scenario: Directory contains workflow files
- **WHEN** `WORKFLOW_DIR` points to a directory containing `cronitor.js` and `alerts.js`
- **THEN** the loader SHALL attempt to load both files

#### Scenario: Directory is empty
- **WHEN** `WORKFLOW_DIR` points to an empty directory
- **THEN** the runtime SHALL start normally with no workflows loaded

#### Scenario: Directory contains non-JS files
- **WHEN** `WORKFLOW_DIR` contains `cronitor.js` and `README.md`
- **THEN** the loader SHALL only attempt to load `cronitor.js`

### Requirement: Dynamic import of workflow modules
The loader SHALL use dynamic `import()` to load each discovered `.js` file and read its default export as a `WorkflowConfig`.

#### Scenario: Valid workflow file
- **WHEN** a `.js` file default-exports a valid `WorkflowConfig`
- **THEN** the loader SHALL return it as a loaded workflow

#### Scenario: File fails to load
- **WHEN** a `.js` file throws an error during `import()`
- **THEN** the loader SHALL log a warning with the file name and error
- **AND** the loader SHALL skip that file and continue loading remaining files

#### Scenario: File has no default export
- **WHEN** a `.js` file has no default export
- **THEN** the loader SHALL log a warning and skip the file

### Requirement: Merge loaded workflows into shared registries
The runtime SHALL merge triggers from all loaded workflows into a single `HttpTriggerRegistry` and combine all actions into a single actions list.

#### Scenario: Two workflows with distinct trigger paths
- **WHEN** workflow A registers trigger path `cronitor` and workflow B registers trigger path `alerts`
- **THEN** both triggers SHALL be available in the shared registry

#### Scenario: Duplicate trigger paths across workflows
- **WHEN** two workflows register the same trigger path and HTTP method
- **THEN** the runtime SHALL fail at startup with an error identifying the conflicting path

### Requirement: Loaded workflows participate in dispatch
All actions from loaded workflows SHALL be included in the dispatch action's fan-out logic.

#### Scenario: Event matches actions from different workflows
- **WHEN** an event type matches actions from two different loaded workflows
- **THEN** the dispatch action SHALL emit targeted events for all matching actions
