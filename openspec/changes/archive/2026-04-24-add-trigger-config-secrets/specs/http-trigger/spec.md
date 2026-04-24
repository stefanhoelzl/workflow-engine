## ADDED Requirements

### Requirement: HTTP trigger descriptor string fields support secret sentinels

Any `string`-typed field of an `HttpTriggerDescriptor` in the manifest MAY carry sentinel substrings produced by the SDK's build-time `SecretEnvRef` resolution. Today such string fields are limited to the `name` and (indirectly) the `method` literal; however, fields that are typed as literal unions (e.g. `method: "GET" | "POST"`) SHALL NOT accept sentinels in practice, because the SDK's `httpTrigger` factory types those fields as unions incompatible with the `SecretEnvRef`-built sentinel strings. Any future `string`-typed addition to the descriptor SHALL receive resolved plaintext from the workflow-registry before the HTTP TriggerSource observes it.

The HTTP TriggerSource SHALL NOT itself parse, match, or recognize sentinel substrings. Its contract remains "receive already-resolved descriptor strings and mount webhook routes accordingly." The webhook URL is derived from trigger `name` (see existing "Trigger URL is derived from export name" requirement); because `name` is not generated via `env({ secret: true })` in author code paths, `name` in practice remains a non-secret identifier surfaced in dashboards and events.

#### Scenario: HTTP TriggerSource never observes sentinel bytes

- **GIVEN** any manifest with sentinel substrings anywhere in HTTP trigger descriptors (including future `string`-typed fields)
- **WHEN** `httpTriggerSource.reconfigure` is called by the registry
- **THEN** no string field reachable from the entries argument SHALL contain the byte sequence `\x00secret:`
