## Why

Workflow secrets are currently usable only from inside action and handler bodies via `globalThis.workflow.env.X`. There is no way to place a secret value into a **trigger's configuration** — e.g. a cron `schedule`, a future webhook-signature key, or the credentials of a future IMAP-style trigger that opens a connection before any handler runs. Trigger backends (`TriggerSource` implementations) execute on the main thread, outside any sandbox, and today their descriptor fields are plain strings with no facility for deferred-resolution secret references.

This change introduces a generic mechanism so that any string-typed field of any trigger descriptor can carry a reference to a workflow-declared secret, which the runtime resolves to plaintext before handing the descriptor to the trigger backend.

## What Changes

- `defineWorkflow(config)` SHALL return a workflow object whose `env` record is a context-sensitive accessor: at build time (Vite VM), reading a secret entry yields a shared-format sentinel string; at runtime (sandbox, where `globalThis.workflow` is installed), reading the same entry yields the decrypted plaintext.
- Every string-typed field of every trigger descriptor (`cronTrigger`, `httpTrigger`, `manualTrigger`, and any future trigger) MAY contain one or more sentinel substrings produced by `defineWorkflow`'s getters. Sentinel substrings embedded via JavaScript template literals are supported (substring resolution).
- The workflow registry's load path SHALL decrypt `manifest.secrets` once per load and walk every trigger descriptor, substituting sentinel substrings with plaintext before calling `TriggerSource.reconfigure`. A sentinel whose name is not present in the decrypted store SHALL cause workflow registration to fail with a `secret_ref_unresolved` error (HTTP 400 on upload, skipped workflow on persistence replay).
- A new shared module `packages/core/src/secret-sentinel.ts` SHALL own the `\x00secret:NAME\x00` encoding. The SDK's `defineWorkflow` getters, the existing worker-side scrubber (`packages/runtime/src/plugins/secrets.ts`), and the new main-side resolver SHALL all import from this module — format lives in exactly one place.
- The existing `globalThis.workflow.env.X` guest access path remains valid and unchanged for action/handler bodies. `wf.env.X` and `globalThis.workflow.env.X` read the same frozen plaintext record inside the sandbox.
- No new trigger kind ships with this change. No existing trigger descriptor gains new fields. No external extension point is introduced. The cron `schedule` field serves as the end-to-end test fixture.
- SECURITY.md §5 SHALL gain an invariant describing the main-thread plaintext surface: permitted inside the registry's decryption + resolution path, inside `TriggerSource` instance state, and at the boundary of handing values to third-party trigger-backend libraries; forbidden in logs, event payloads, error messages, HTTP responses, dashboard renders, or bus traffic.

## Capabilities

### New Capabilities
_None._

### Modified Capabilities
- `workflow-secrets`: new requirement that secret references may appear as sentinel substrings inside trigger descriptor string fields and are resolved at workflow-registration time.
- `workflow-env-runtime`: `defineWorkflow` returns a `wf.env` record whose secret entries are context-sensitive getters (sentinel at build, plaintext at runtime); `globalThis.workflow.env` remains the canonical runtime source and is read by those getters.
- `workflow-registry`: load path SHALL resolve sentinel substrings in trigger descriptors before dispatching to `TriggerSource.reconfigure`; MUST fail registration with a structured error when a sentinel references an unknown name.
- `sdk`: `defineWorkflow`'s return type exposes `wf.env` as `Readonly<Record<string, string>>`; `SecretEnvRef` becomes an SDK-internal type not part of the public author surface.
- `core-package`: new exported `secret-sentinel` module providing `encodeSentinel` and `SENTINEL_SUBSTRING_RE`, shared by SDK, runtime scrubber, and the new runtime resolver.
- `cron-trigger`, `http-trigger`, `manual-trigger`: descriptor string fields MAY carry sentinel substrings at the manifest layer; `TriggerSource` implementations SHALL receive only resolved plaintext in `reconfigure` entries and MUST NOT parse sentinels themselves.

## Impact

- **Code paths**:
  - `packages/core/src/secret-sentinel.ts` (new; exports `encodeSentinel`, `SENTINEL_SUBSTRING_RE`).
  - `packages/sdk/src/index.ts` (`defineWorkflow` returns `wf.env` with getters; effective secret name stamped onto internal refs at `defineWorkflow` time; `SecretEnvRef` becomes internal).
  - `packages/runtime/src/plugins/secrets.ts` (import regex from shared module; no behavioral change to the scrubber).
  - `packages/runtime/src/triggers/resolve-secret-sentinels.ts` (new; substring-replace walker).
  - Workflow registry load path (decrypt + resolve before `TriggerSource.reconfigure`; throw on missing names).
  - `SECURITY.md` §5 (new invariants).
- **Manifest format**: no schema change. Sentinel strings sit inside existing `z.string()` fields.
- **Upload / seal pipeline**: no change. `secretBindings` → encrypt → `manifest.secrets` flow is unchanged.
- **Breaking changes**: none at the manifest or upload layer. Authors who currently use `globalThis.workflow.env.X` in handler bodies continue to work; `wf.env.X` is additive.
- **Performance**: `decryptWorkflowSecrets` runs once per workflow registration in addition to the existing per-sandbox-spawn call. No cache is introduced; revisit only if profiling shows crypto on the invocation hot path.
- **Dependencies**: none added.
