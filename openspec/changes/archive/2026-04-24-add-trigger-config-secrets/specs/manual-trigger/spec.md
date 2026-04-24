## ADDED Requirements

### Requirement: Manual trigger descriptor string fields support secret sentinels

Any `string`-typed field of a `ManualTriggerDescriptor` in the manifest MAY carry sentinel substrings produced by the SDK's build-time `SecretEnvRef` resolution. Manual trigger descriptors currently carry only `name` plus input/output JSON Schemas; `name` is the author-visible identifier surfaced in the `/trigger` UI and SHOULD NOT be secret-sourced. The manual TriggerSource SHALL NOT itself parse, match, or recognize sentinel substrings; it receives already-resolved plaintext from the workflow-registry (see `workflow-registry` spec: "Registry resolves secret sentinels before reconfiguring backends").

This requirement exists to bind the manual-trigger backend to the shared contract: any future `string`-typed addition to `ManualTriggerDescriptor` automatically inherits sentinel resolution at the registry layer without needing backend code changes.

#### Scenario: Manual TriggerSource never observes sentinel bytes

- **GIVEN** any manifest with sentinel substrings anywhere in manual trigger descriptors
- **WHEN** `manualTriggerSource.reconfigure` is called by the registry
- **THEN** no string field reachable from the entries argument SHALL contain the byte sequence `\x00secret:`
