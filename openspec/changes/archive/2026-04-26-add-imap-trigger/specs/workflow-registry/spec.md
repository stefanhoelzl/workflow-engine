## ADDED Requirements

### Requirement: Registry dispatches imap-kind triggers to ImapTriggerSource

The runtime SHALL construct the `WorkflowRegistry` with an `ImapTriggerSource` included in the `backends` list so that manifests containing `type: "imap"` trigger descriptors are accepted (per the existing "Registry knows its backends and rejects unknown kinds" requirement). On every successful `registerTenant` call, the registry SHALL partition trigger entries by `descriptor.kind` and SHALL pass all entries with `kind === "imap"` to `imapSource.reconfigure(owner, repo, entries)` in parallel with other backends (per the existing "Registry reconfigures backends per-tenant in parallel" requirement).

Existing generic requirements — secret-sentinel resolution before `reconfigure`, persist-on-full-success, derived-index rebuild, etc. — SHALL apply to imap entries without imap-specific additions.

#### Scenario: Manifest with imap trigger registers successfully

- **GIVEN** a registry constructed with backends `[httpSource, cronSource, manualSource, imapSource]`
- **WHEN** a tenant uploads a manifest containing a single `type: "imap"` trigger with a valid descriptor
- **THEN** the manifest SHALL be accepted
- **AND** `imapSource.reconfigure(owner, repo, [entry])` SHALL be called exactly once
- **AND** the other backends SHALL be called with empty entry lists for this `(owner, repo)` tuple

#### Scenario: Sentinels in imap descriptor resolved before reconfigure

- **GIVEN** a manifest whose imap trigger has `password: "\x00secret:IMAP_PASSWORD\x00"` and `manifest.secrets.IMAP_PASSWORD` contains the ciphertext of `"devpass"`
- **WHEN** the registry installs the workflow
- **THEN** the descriptor passed to `imapSource.reconfigure` SHALL contain `password: "devpass"`
- **AND** no string in the descriptor SHALL contain the byte sequence `\x00secret:`

#### Scenario: Registry rejects imap kind when ImapTriggerSource is not registered

- **GIVEN** a registry constructed with `[httpSource, cronSource]` (no imap backend)
- **WHEN** a manifest containing `type: "imap"` is uploaded
- **THEN** the registry SHALL reject the manifest with a validation error naming `"imap"` as the unsupported kind
- **AND** no `reconfigure` SHALL be invoked on any backend
