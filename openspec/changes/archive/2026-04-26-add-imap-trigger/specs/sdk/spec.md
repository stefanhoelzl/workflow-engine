## MODIFIED Requirements

### Requirement: Brand symbols identify SDK products

The SDK SHALL export six brand symbols used to identify objects produced by its factories:
- `ACTION_BRAND = Symbol.for("@workflow-engine/action")`
- `HTTP_TRIGGER_BRAND = Symbol.for("@workflow-engine/http-trigger")`
- `CRON_TRIGGER_BRAND = Symbol.for("@workflow-engine/cron-trigger")`
- `MANUAL_TRIGGER_BRAND = Symbol.for("@workflow-engine/manual-trigger")`
- `IMAP_TRIGGER_BRAND = Symbol.for("@workflow-engine/imap-trigger")`
- `WORKFLOW_BRAND = Symbol.for("@workflow-engine/workflow")`

The SDK SHALL provide type guards `isAction(value)`, `isHttpTrigger(value)`, `isCronTrigger(value)`, `isManualTrigger(value)`, `isImapTrigger(value)`, `isWorkflow(value)` that check for the corresponding brand symbol.

#### Scenario: Brand on each factory return value

- **WHEN** `action(...)`, `httpTrigger(...)`, `cronTrigger(...)`, `manualTrigger(...)`, `imapTrigger(...)`, or `defineWorkflow(...)` is called
- **THEN** the returned value SHALL have the corresponding brand symbol set to `true`

#### Scenario: Type guard recognizes branded value

- **GIVEN** a value `v` returned from `action({...})`
- **WHEN** `isAction(v)` is called
- **THEN** the function SHALL return `true`

#### Scenario: Type guard rejects unrelated value

- **GIVEN** a plain function `() => 1`
- **WHEN** `isAction(value)` is called
- **THEN** the function SHALL return `false`

#### Scenario: isCronTrigger recognizes cron trigger values

- **GIVEN** a value `v` returned from `cronTrigger({...})`
- **WHEN** `isCronTrigger(v)` is called
- **THEN** the function SHALL return `true`
- **AND** `isHttpTrigger(v)` SHALL return `false`
- **AND** `isManualTrigger(v)` SHALL return `false`
- **AND** `isImapTrigger(v)` SHALL return `false`

#### Scenario: isManualTrigger recognizes manual trigger values

- **GIVEN** a value `v` returned from `manualTrigger({...})`
- **WHEN** `isManualTrigger(v)` is called
- **THEN** the function SHALL return `true`
- **AND** `isHttpTrigger(v)` SHALL return `false`
- **AND** `isCronTrigger(v)` SHALL return `false`
- **AND** `isImapTrigger(v)` SHALL return `false`

#### Scenario: isImapTrigger recognizes imap trigger values

- **GIVEN** a value `v` returned from `imapTrigger({...})`
- **WHEN** `isImapTrigger(v)` is called
- **THEN** the function SHALL return `true`
- **AND** `isHttpTrigger(v)` SHALL return `false`
- **AND** `isCronTrigger(v)` SHALL return `false`
- **AND** `isManualTrigger(v)` SHALL return `false`

## ADDED Requirements

### Requirement: imapTrigger factory

The SDK SHALL export an `imapTrigger(config)` factory per the `imap-trigger` capability. The factory SHALL return an `ImapTrigger` value branded with `IMAP_TRIGGER_BRAND` and callable as `(msg: ImapMessage) => Promise<ImapTriggerResult>`. The SDK SHALL additionally re-export the `ImapMessage` and `ImapTriggerResult` TypeScript types from the package root so author code can spell the handler argument and return shapes.

The factory SHALL default omitted optional fields as follows: `tls` → `"required"`, `insecureSkipVerify` → `false`, `onError` → `{}`.

The SDK SHALL enforce at the TypeScript type level that `handler`'s return type satisfies `Promise<ImapTriggerResult>`; a handler that returns `void` or an otherwise-mismatched shape SHALL be a compile error.

#### Scenario: imapTrigger is exported from SDK root

- **WHEN** a workflow author imports `{ imapTrigger }` from `"@workflow-engine/sdk"`
- **THEN** the import SHALL resolve to the factory
- **AND** calling it with a valid config SHALL return a branded callable

#### Scenario: ImapMessage and ImapTriggerResult types are re-exported

- **WHEN** a workflow author imports `type { ImapMessage, ImapTriggerResult }` from `"@workflow-engine/sdk"`
- **THEN** the imports SHALL resolve to the types defined by the `imap-trigger` capability

#### Scenario: Handler return type is enforced at compile time

- **GIVEN** `imapTrigger({ ..., handler: async () => {} })` where the handler returns `void`
- **WHEN** the workflow is type-checked
- **THEN** TypeScript SHALL emit a compile error
- **AND** the error SHALL indicate that the handler must return `Promise<ImapTriggerResult>`
