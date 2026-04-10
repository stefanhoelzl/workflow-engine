## ADDED Requirements

### Requirement: BASE_URL configuration
The config schema SHALL accept an optional `BASE_URL` environment variable. It SHALL be a string and SHALL have no default value. When provided, it SHALL be available as `baseUrl` in the config object.

#### Scenario: BASE_URL is set
- **WHEN** `createConfig` is called with `{ BASE_URL: "https://workflows.example.com" }`
- **THEN** the config SHALL contain `baseUrl: "https://workflows.example.com"`

#### Scenario: BASE_URL is not set
- **WHEN** `createConfig` is called without `BASE_URL`
- **THEN** `baseUrl` SHALL be `undefined`

#### Scenario: BASE_URL with HTTP
- **WHEN** `createConfig` is called with `{ BASE_URL: "http://localhost:8080" }`
- **THEN** the config SHALL contain `baseUrl: "http://localhost:8080"`
