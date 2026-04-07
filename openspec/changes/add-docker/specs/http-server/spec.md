## MODIFIED Requirements

### Requirement: Server port is configurable via PORT environment variable

The runtime SHALL read the `PORT` environment variable to determine the HTTP server listen port. If `PORT` is not set, it SHALL default to `8080`.

#### Scenario: PORT env var is set
- **WHEN** the runtime starts with `PORT=9090`
- **THEN** the HTTP server SHALL listen on port 9090

#### Scenario: PORT env var is not set
- **WHEN** the runtime starts without a `PORT` environment variable
- **THEN** the HTTP server SHALL listen on port 8080

#### Scenario: Startup log includes the port
- **WHEN** the runtime starts
- **THEN** it SHALL log `Runtime listening on port <port>` with the actual port number
