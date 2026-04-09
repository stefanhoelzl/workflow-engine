## MODIFIED Requirements

### Requirement: ActionContext env property

The `ActionContext` SHALL provide an `env` property that gives access to environment variables. The `env` property SHALL be typed as `Record<string, string>` (no `undefined`). The env values SHALL be the per-action resolved values from the workflow manifest, not `process.env`.

#### Scenario: Access environment variable
- **GIVEN** an `ActionContext` created with env `{ "API_KEY": "secret", "BASE_URL": "https://example.com" }`
- **WHEN** the handler accesses `ctx.env.API_KEY`
- **THEN** the value is `"secret"`

#### Scenario: Env does not contain undeclared variables
- **GIVEN** an `ActionContext` created with env `{ "API_KEY": "secret" }`
- **AND** `process.env.OTHER_VAR` is `"other"`
- **WHEN** the handler accesses `ctx.env`
- **THEN** `ctx.env` SHALL NOT contain `OTHER_VAR`

### Requirement: createActionContext factory function

The system SHALL provide a `createActionContext(source: EventSource, fetch: typeof globalThis.fetch, logger: Logger)` function that returns `(event: RuntimeEvent, actionName: string, env: Record<string, string>) => ActionContext`. The factory SHALL NOT accept a global env parameter; env SHALL be provided per-invocation.

#### Scenario: Create action context factory
- **GIVEN** an EventSource, fetch function, and Logger
- **WHEN** `createActionContext(source, fetch, logger)` is called
- **THEN** a function is returned that accepts a RuntimeEvent, action name, and per-action env record, and returns an ActionContext

#### Scenario: Factory function produces working ActionContext with per-action env
- **GIVEN** a context factory created via `createActionContext(source, fetch, logger)`
- **AND** a RuntimeEvent `evt_001` and env `{ "KEY": "value" }`
- **WHEN** `factory(evt_001, "myAction", { "KEY": "value" })` is called
- **THEN** the returned ActionContext has `event` set to `evt_001`, working `emit()`, `fetch()`, and `env` set to `{ "KEY": "value" }`
