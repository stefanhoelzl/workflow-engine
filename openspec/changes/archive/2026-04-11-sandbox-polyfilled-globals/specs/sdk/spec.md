## MODIFIED Requirements

### Requirement: ActionContext type in SDK

The SDK's `ActionContext` type SHALL include `event`, `env`, and `emit`. It SHALL NOT include a `fetch` property. Network access is provided by the global `fetch` function (a polyfill), not by a method on the context.

#### Scenario: ActionContext type has no fetch

- **GIVEN** a workflow action handler typed with the SDK's `ActionContext`
- **WHEN** the handler attempts to access `ctx.fetch`
- **THEN** TypeScript SHALL report a type error (property does not exist)

#### Scenario: ActionContext type has emit and env

- **GIVEN** a workflow action handler typed with the SDK's `ActionContext`
- **WHEN** the handler accesses `ctx.emit` and `ctx.env`
- **THEN** both are properly typed and accessible
