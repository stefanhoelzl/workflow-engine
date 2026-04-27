## MODIFIED Requirements

### Requirement: Cron schedule grammar at the manifest layer

The manifest-layer `ManifestSchema` SHALL accept any non-empty `schedule` string for cron triggers; grammar enforcement is delegated to `cron-parser` (already used by the runtime cron source's `CronExpressionParser.parse`). The SDK's compile-time `ts-cron-validator` template-literal check on `cronTrigger`'s `schedule` argument is unchanged and continues to enforce a standard 5-field grammar against author-supplied literals at `pnpm check` time.

This split — permissive at runtime parsing, strict at SDK compile time — keeps 6-field (with-seconds) schedules usable from contexts the SDK type-system cannot see (template-literal fixtures, manifest authoring outside the SDK, secret-sentinel resolution producing arbitrary plaintext) without weakening the author-facing TypeScript guarantee on hand-written 5-field literals.

#### Scenario: 6-field schedule passes the manifest layer

- **GIVEN** a manifest with a cron trigger whose `schedule` is `"* * * * * *"` (six fields, every-second)
- **WHEN** the manifest is parsed via `ManifestSchema`
- **THEN** parsing SHALL succeed
- **AND** the runtime cron source SHALL parse the schedule via `cron-parser` and arm the next tick at the resolved instant

#### Scenario: Genuinely malformed schedule surfaces at runtime, not at the manifest layer

- **GIVEN** a manifest with a cron trigger whose `schedule` is `"not a cron"`
- **WHEN** the manifest is parsed via `ManifestSchema`
- **THEN** parsing SHALL succeed (manifest layer is permissive)
- **AND** the runtime cron source's `CronExpressionParser.parse` SHALL throw on first arm, surfacing as a `cron.schedule-invalid` log line and a no-op for that entry's timer

#### Scenario: SDK's compile-time validator still rejects malformed literals

- **GIVEN** a TypeScript source `cronTrigger({ schedule: "0 0 9 * * *", handler: async () => {} })` (six-field, hand-written literal)
- **WHEN** the file is type-checked via `pnpm check`
- **THEN** TypeScript SHALL reject the call with a type error on the `schedule` argument (the SDK's `StandardCRON` template-literal constraint is unchanged)
