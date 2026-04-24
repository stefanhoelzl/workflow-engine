## MODIFIED Requirements

### Requirement: Reconfigure is per-tenant full-replace

Every `TriggerSource` backend SHALL implement a `reconfigure(owner, repo, entries)` method that REPLACES the entries registered for the given `(owner, repo)` pair with the supplied list. Passing an empty `entries` array SHALL clear all entries for that `(owner, repo)`. Entries for other `(owner, repo)` pairs (including sibling repos under the same owner) SHALL NOT be affected.

The backend's internal state SHALL be keyed by the triple `(owner, repo, trigger-identity)` — never by `owner` alone or by `(owner, workflow)` without `repo`. Two uploads to different repos under the same owner SHALL produce independent entry sets.

The method SHALL return `{ ok: true }` on success or `{ ok: false, errors: TriggerConfigError[] }` when at least one entry cannot be registered (e.g. invalid cron expression). Infrastructure failures (e.g. network unreachable) SHALL be thrown, not returned, so the registry can classify the failure category.

#### Scenario: Empty entries clears the (owner, repo) slice

- **GIVEN** a cron backend with 3 entries registered for `(acme, foo)` and 2 entries for `(acme, bar)`
- **WHEN** the registry calls `cronSource.reconfigure("acme", "foo", [])`
- **THEN** all 3 cron entries for `(acme, foo)` SHALL be unregistered
- **AND** the 2 entries for `(acme, bar)` SHALL remain unchanged

#### Scenario: Replacing entries does not affect siblings

- **GIVEN** a cron backend with entries for `(acme, foo)` and `(acme, bar)`
- **WHEN** the registry calls `cronSource.reconfigure("acme", "foo", [newEntry])`
- **THEN** `(acme, foo)` SHALL have exactly one entry (the new one)
- **AND** `(acme, bar)` SHALL be unchanged

#### Scenario: Success returns ok-true

- **WHEN** a backend successfully registers all supplied entries
- **THEN** `reconfigure` SHALL return `{ ok: true }`

#### Scenario: User-config error returns ok-false with errors

- **WHEN** an entry has an invalid cron expression
- **THEN** `reconfigure` SHALL return `{ ok: false, errors: [{backend, trigger, message}] }` listing the offending entries

#### Scenario: Infra error is thrown

- **WHEN** the backend cannot reach its downstream infrastructure (e.g. external scheduler service unreachable)
- **THEN** `reconfigure` SHALL throw the underlying error
- **AND** SHALL NOT return `{ ok: false }`

### Requirement: TriggerEntry carries descriptor and fire callback

Each `TriggerEntry` passed to `reconfigure` SHALL carry:

```
TriggerEntry = {
  owner:       string
  repo:        string
  workflow:    string
  triggerName: string
  descriptor:  BaseTriggerDescriptor
  fire:        (input: unknown) => Promise<InvokeResult<unknown>>
}
```

The `owner` and `repo` fields SHALL match the `(owner, repo)` under which the bundle was uploaded. Combined with `workflow` and `triggerName`, they form the globally-unique trigger identity. Two triggers with the same `workflow` + `triggerName` SHALL coexist if their `(owner, repo)` differs.

The `fire` callback SHALL be constructed solely by the registry via `buildFire` (see `workflow-registry` spec); backends SHALL NOT construct their own `fire` closures.

#### Scenario: Entry includes full scope

- **GIVEN** a manifest uploaded to `(acme, foo)` declaring workflow `deploy` with cron trigger `nightly`
- **WHEN** the registry constructs the TriggerEntry
- **THEN** the entry SHALL contain `owner: "acme"`, `repo: "foo"`, `workflow: "deploy"`, `triggerName: "nightly"`

#### Scenario: Same workflow/trigger name across repos produces distinct entries

- **GIVEN** `(acme, foo)` and `(acme, bar)` both declaring workflow `deploy` with cron trigger `nightly`
- **WHEN** both bundles are uploaded
- **THEN** the cron backend SHALL hold two distinct entries differing in `repo`
- **AND** each entry's `fire` callback SHALL route to the correct bundle's `deploy` workflow
