## ADDED Requirements

### Requirement: Secret references permitted in trigger descriptor string fields

The workflow manifest SHALL permit string-typed fields of any trigger descriptor to contain one or more sentinel substrings encoded via `encodeSentinel(name)` from `@workflow-engine/core/secret-sentinel`. The sentinel form is `\x00secret:NAME\x00` where `NAME` matches `/^[A-Za-z_][A-Za-z0-9_]*$/`.

Sentinel substrings SHALL NOT require schema changes to any trigger descriptor: because sentinels are valid `string` values, the existing `z.string()` fields (e.g. cron `schedule`, `tz`; http request-method labels; manual trigger-name routing values; and any future trigger-config string field) validate unchanged.

A sentinel substring in a trigger descriptor field SHALL reference a secret name that also appears in `manifest.secrets` (i.e. a secret declared via `env({ secret: true })` in the workflow's `defineWorkflow.env` and encrypted by `wfe upload`). Author code cannot produce a sentinel for a non-declared name: the only path to emit a sentinel is the SDK's build-time `SecretEnvRef` resolution, and `SecretEnvRef` instances originate exclusively from `env({ secret: true })` entries that `defineWorkflow` also collects into `manifest.secretBindings`.

#### Scenario: Trigger config carries a whole-value sentinel

- **GIVEN** a workflow `const wf = defineWorkflow({ env: { S: env({ secret: true }) } })`
- **WHEN** the author writes `cronTrigger({ name: "tick", schedule: wf.env.S, tz: "UTC", handler: async () => {} })`
- **THEN** `manifest.triggers[0].schedule` SHALL equal `"\x00secret:S\x00"`
- **AND** `manifest.secretBindings` SHALL contain `"S"`

#### Scenario: Trigger config carries a composed (substring) sentinel

- **GIVEN** a workflow declaring `env: { T: env({ secret: true }) }` and a future trigger factory accepting an `authHeader: z.string()` field
- **WHEN** the author writes `` futureTrigger({ authHeader: `Bearer ${wf.env.T}` }) ``
- **THEN** the emitted manifest field SHALL equal the string `"Bearer \x00secret:T\x00"`

#### Scenario: Multiple sentinels in one trigger-config string

- **GIVEN** `env: { U: env({ secret: true }), P: env({ secret: true }) }`
- **WHEN** the author uses `` `imaps://${wf.env.U}:${wf.env.P}@host:993` `` as a trigger-config field
- **THEN** the emitted manifest field SHALL contain both sentinels in order

### Requirement: Workflow registration resolves sentinel substrings before TriggerSource.reconfigure

When the `WorkflowRegistry` loads a manifest (via `registerTenant(...)` at upload, or via `recover()` at boot), it SHALL, after decrypting `manifest.secrets` into a `plaintextStore: Record<string, string>`, walk every trigger descriptor in the manifest and replace every occurrence of the `SENTINEL_SUBSTRING_RE` pattern with `plaintextStore[capturedName]` before passing entries to any `TriggerSource.reconfigure` call.

The walk SHALL:

1. Traverse plain JavaScript objects and arrays contained in each trigger descriptor recursively.
2. For each string value encountered, run `str.replace(SENTINEL_SUBSTRING_RE, (match, name) => …)`:
   - If `name in plaintextStore`, substitute with `plaintextStore[name]`.
   - Otherwise, record `name` in a `missing: Set<string>` accumulated across the full walk and leave the sentinel bytes in place.
3. Leave non-string scalar values (numbers, booleans, null) unchanged.

After the walk completes:

- If `missing.size > 0`, the registry SHALL throw a `WorkflowRegistrationError` with `code: "secret_ref_unresolved"` and a `missing` field listing every unresolved name. The registry SHALL NOT call `reconfigure` on any backend for this workflow. At upload, this SHALL surface as HTTP `400` with body `{ error: "secret_ref_unresolved", workflow: <name>, missing: [...] }`. During boot recovery, this SHALL be logged and the single failing workflow SHALL be absent from the registry until re-uploaded; other workflows in the recovery set SHALL load normally.
- Otherwise, the registry SHALL pass the resolved descriptors to each `TriggerSource.reconfigure`. Descriptors passed to `reconfigure` SHALL contain no sentinel substrings.

The sentinel-resolution walk SHALL be the sole validation site for sentinel-name coverage. The upload handler SHALL NOT separately pre-validate that every sentinel name appears in `manifest.secrets`; the registry's walk is authoritative.

`TriggerSource` implementations SHALL NOT parse sentinel substrings themselves. They SHALL treat every string in the descriptors they receive via `reconfigure` as already-resolved plaintext.

#### Scenario: Cron schedule sentinel resolved before reconfigure

- **GIVEN** a manifest with `triggers[0] = { name: "tick", type: "cron", schedule: "\x00secret:S\x00", tz: "UTC", … }` and `manifest.secrets = { S: "<ciphertext of "*/5 * * * *">" }`
- **WHEN** the registry installs the workflow
- **THEN** the cron `TriggerSource.reconfigure` SHALL receive an entry whose descriptor has `schedule: "*/5 * * * *"`
- **AND** the entry's descriptor SHALL NOT contain the byte sequence `\x00secret:`

#### Scenario: Substring sentinel resolved before reconfigure

- **GIVEN** a manifest trigger config containing a string `"Bearer \x00secret:T\x00"` and `manifest.secrets = { T: "<ciphertext of "abc123">" }`
- **WHEN** the registry installs the workflow
- **THEN** the `TriggerSource.reconfigure` entry SHALL contain the string `"Bearer abc123"` at the same position

#### Scenario: Multiple sentinels in one string resolved

- **GIVEN** a trigger-config string `"\x00secret:A\x00-\x00secret:B\x00"` with secrets `A="x"`, `B="y"`
- **WHEN** the registry resolves it
- **THEN** the resulting string SHALL be `"x-y"`

#### Scenario: Unknown sentinel name fails workflow registration

- **GIVEN** a manifest with a trigger-config sentinel `"\x00secret:UNKNOWN\x00"` and `manifest.secrets` NOT containing key `"UNKNOWN"`
- **WHEN** the registry attempts to install the workflow
- **THEN** the registry SHALL throw `WorkflowRegistrationError` with `code: "secret_ref_unresolved"` and `missing: ["UNKNOWN"]`
- **AND** no `TriggerSource.reconfigure` call SHALL be made for this workflow
- **AND** at upload, the HTTP response SHALL be `400` with body `{ error: "secret_ref_unresolved", workflow: <name>, missing: ["UNKNOWN"] }`

#### Scenario: Boot recovery skips a broken workflow and continues

- **GIVEN** a persistence store with two workflows, one of which has an unresolved sentinel
- **WHEN** the runtime boots and calls `recover()`
- **THEN** the broken workflow SHALL be absent from the registry
- **AND** an error SHALL be logged identifying the workflow and missing names
- **AND** the other workflow SHALL be registered normally

#### Scenario: TriggerSource never observes sentinel bytes

- **GIVEN** any manifest with sentinels in trigger configs
- **WHEN** any `TriggerSource.reconfigure` is called by the registry
- **THEN** every string value reachable from the entries argument SHALL NOT contain the byte sequence `\x00secret:`

### Requirement: Main-thread plaintext confinement within engine code

Decrypted secret plaintext on the main thread SHALL NOT appear in:

- log lines (any log level, any logger),
- event payloads published on the bus,
- error messages, error `cause` chains, or stack traces formatted for user display,
- HTTP response bodies or headers,
- dashboard rendered output or server-sent-event streams,
- any code path whose purpose is not to implement a trigger backend (`TriggerSource`).

Decrypted plaintext IS permitted in:

- the `WorkflowRegistry` load path's sentinel-resolution call stack and the resolved entries passed to `TriggerSource.reconfigure`,
- `TriggerSource` instance state set via `reconfigure` (e.g. a cron source's in-memory timer binding, a future IMAP source's connection credentials),
- values passed from a `TriggerSource` to a third-party library at the TriggerSource boundary. Memory-lifetime of plaintext inside third-party libraries is explicitly out-of-scope for engine-level guarantees.

The worker-side plaintext scrubber (existing) SHALL continue to redact plaintext literals from outbound `WorkerToMain` messages. No equivalent main-thread scrubber is introduced.

#### Scenario: TriggerSource receives and retains plaintext

- **WHEN** the registry resolves a cron `schedule` sentinel to its plaintext and calls `cronTriggerSource.reconfigure(owner, repo, entries)`
- **THEN** the cron source MAY store the resolved schedule string in its in-memory timer binding
- **AND** the cron source MUST NOT include that string in any emitted event, log line, or error

#### Scenario: Third-party library handoff is a boundary, not a leak

- **GIVEN** a future IMAP TriggerSource that passes a plaintext password to an IMAP client library
- **WHEN** the library internally stashes the password in a connection object or socket buffer
- **THEN** that is explicitly permitted
- **AND** the engine's lifetime guarantees for main-thread plaintext do not extend past the library boundary
