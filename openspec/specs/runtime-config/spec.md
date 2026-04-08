### Requirement: Config parsing from environment
The runtime SHALL provide a `createConfig` function that accepts an environment record (`Record<string, string | undefined>`) and returns a typed, validated configuration object.

#### Scenario: Valid environment with all values provided
- **WHEN** `createConfig` is called with `{ LOG_LEVEL: "debug", PORT: "3000" }`
- **THEN** it SHALL return `{ logLevel: "debug", port: 3000 }`

#### Scenario: Empty environment uses defaults
- **WHEN** `createConfig` is called with `{}`
- **THEN** it SHALL return `{ logLevel: "info", port: 8080 }`

#### Scenario: Partial environment fills missing values with defaults
- **WHEN** `createConfig` is called with `{ PORT: "9090" }`
- **THEN** it SHALL return `{ logLevel: "info", port: 9090 }`

### Requirement: LOG_LEVEL validation
The `LOG_LEVEL` config value SHALL only accept valid pino log levels: `fatal`, `error`, `warn`, `info`, `debug`, `trace`. It SHALL default to `info` when not provided.

#### Scenario: Valid log level
- **WHEN** `createConfig` is called with `{ LOG_LEVEL: "debug" }`
- **THEN** it SHALL return a config with `logLevel` set to `"debug"`

#### Scenario: Invalid log level
- **WHEN** `createConfig` is called with `{ LOG_LEVEL: "verbose" }`
- **THEN** it SHALL throw a validation error

### Requirement: PORT validation
The `PORT` config value SHALL be coerced from a string to a number. It SHALL default to `8080` when not provided.

#### Scenario: Valid port string
- **WHEN** `createConfig` is called with `{ PORT: "3000" }`
- **THEN** it SHALL return a config with `port` set to `3000` (number)

#### Scenario: Non-numeric port
- **WHEN** `createConfig` is called with `{ PORT: "abc" }`
- **THEN** it SHALL throw a validation error

### Requirement: Main entry point uses config object
The runtime entry point (`main.ts`) SHALL use the config object returned by `createConfig` for all server-level configuration instead of accessing `process.env` directly.

#### Scenario: Server startup uses config
- **WHEN** the runtime starts
- **THEN** the logger level SHALL be set from `config.logLevel`
- **AND** the HTTP server SHALL listen on `config.port`

### Requirement: WORKFLOW_DIR config variable
The config schema SHALL include a `WORKFLOW_DIR` field that accepts a string path. It SHALL have no default value and SHALL be required.

#### Scenario: WORKFLOW_DIR is set
- **WHEN** `createConfig` is called with `{ WORKFLOW_DIR: "/app/workflows" }`
- **THEN** it SHALL return a config with `workflowDir` set to `"/app/workflows"`

#### Scenario: WORKFLOW_DIR is not set
- **WHEN** `createConfig` is called without `WORKFLOW_DIR`
- **THEN** it SHALL throw a validation error
