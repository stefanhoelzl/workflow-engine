## ADDED Requirements

### Requirement: Core package provides ImapTrigger manifest schema

`@workflow-engine/core` SHALL export `imapTriggerManifestSchema` — a Zod object discriminated on `type: "imap"` — and SHALL include it in the manifest trigger-descriptor union alongside the existing `cron` / `http` / `manual` discriminators. The schema SHALL validate the following shape:

```
{
  name: z.string(),
  type: z.literal("imap"),
  host: z.string(),
  port: z.number(),
  tls: z.enum(["required", "starttls", "none"]),
  insecureSkipVerify: z.boolean(),
  user: z.string(),
  password: z.string(),
  folder: z.string(),
  search: z.string(),
  onError: z.object({ command: z.array(z.string()).optional() }),
  inputSchema: jsonSchemaValidator,
  outputSchema: jsonSchemaValidator,
}
```

All `z.string()` fields (`host`, `user`, `password`, `folder`, `search`) SHALL accept `\x00secret:NAME\x00` sentinel substrings unchanged — the existing sentinel-resolution pipeline in `WorkflowRegistry.install` covers them without further schema work. Non-string fields (`port`, `tls`, `insecureSkipVerify`) are literal-only at build time.

Core SHALL also export the `ImapMessage` and `ImapTriggerResult` TypeScript types (value-level Zod schemas for runtime validation and type-level aliases for SDK re-export). `ImapTriggerResult` SHALL equal `z.object({ command: z.array(z.string()).optional() })`.

#### Scenario: Runtime imports imap manifest schema from core

- **WHEN** the runtime imports `imapTriggerManifestSchema` from `@workflow-engine/core`
- **THEN** the symbol SHALL resolve and SHALL be a Zod object

#### Scenario: Manifest with imap trigger validates

- **GIVEN** a manifest trigger descriptor `{ type: "imap", name: "inbound", host: "h", port: 993, tls: "required", insecureSkipVerify: false, user: "u", password: "p", folder: "INBOX", search: "UNSEEN", onError: {}, inputSchema: {...}, outputSchema: {...} }`
- **WHEN** `ManifestSchema.parse(manifest)` runs
- **THEN** validation SHALL succeed

#### Scenario: Manifest with sentinel in password validates

- **GIVEN** the same descriptor with `password: "\x00secret:IMAP_PASSWORD\x00"`
- **WHEN** `ManifestSchema.parse(manifest)` runs
- **THEN** validation SHALL succeed
- **AND** the password field SHALL round-trip the sentinel bytes unchanged

#### Scenario: Manifest with invalid port fails

- **GIVEN** the same descriptor with `port: "993"` (string instead of number)
- **WHEN** `ManifestSchema.parse(manifest)` runs
- **THEN** validation SHALL fail with an error on the `port` field

#### Scenario: Manifest with unknown tls mode fails

- **GIVEN** the same descriptor with `tls: "ssl"` (not in the enum)
- **WHEN** `ManifestSchema.parse(manifest)` runs
- **THEN** validation SHALL fail with an error on the `tls` field
