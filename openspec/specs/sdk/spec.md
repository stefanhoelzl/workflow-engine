# SDK Specification

## Purpose

Provide the TypeScript API for defining workflows, actions, triggers, and typing handlers. The SDK is a build-time-only dependency --- no SDK code ships in the bundled workflow files.
## Requirements
### Requirement: Zod v4 dependency

The SDK SHALL depend on `@workflow-engine/core` (which provides Zod) and re-export the `z` namespace from core. Workflow authors use `z.object()`, `z.string()`, etc. from the SDK import.

#### Scenario: Workflow author imports z from SDK

- **WHEN** a workflow file does `import { z } from "@workflow-engine/sdk"`
- **THEN** it receives the Zod v4 `z` namespace (re-exported from core)

#### Scenario: Workflow authors use Zod v4 API

- **GIVEN** a workflow file that imports `z` from `@workflow-engine/sdk`
- **WHEN** the author uses `z.object()`, `z.string()`, `z.enum()`, `z.nullable()`
- **THEN** these SHALL be Zod v4 functions

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

### Requirement: defineWorkflow factory

The SDK SHALL export `defineWorkflow(config)` returning a `Workflow` object branded with `WORKFLOW_BRAND`. The config SHALL accept optional `name?: string` and optional `env?: Record<string, string | EnvRef>`. When `name` is omitted, the build system SHALL derive the workflow name from the file's filestem.

The returned `Workflow<Env>` SHALL extend `RuntimeWorkflow<Env>` from `@workflow-engine/core`, so `Workflow.env` is a `Readonly<Record<string, string>>` typed to the author's declared env shape. The `Workflow` type SHALL add the brand symbol but otherwise inherit `name` and `env` from `RuntimeWorkflow`.

```ts
interface Workflow<
  Env extends Readonly<Record<string, string>> = Readonly<Record<string, string>>,
> extends RuntimeWorkflow<Env> {
  readonly [WORKFLOW_BRAND]: true;
}
```

At runtime inside the guest VM, `defineWorkflow` SHALL read `globalThis.workflow` (typed via the ambient augmentation in core). It SHALL narrow the retrieved value's env shape to match the author's declared env via a cast, and MUST NOT call `resolveEnvRecord` at runtime. The `name` field SHALL be taken from `globalThis.workflow.name` if present, falling back to `config.name` if the global is absent (defensive for build-time Node-VM discovery before the plugin installs the global).

At build time inside the Vite plugin's Node-VM discovery context, the plugin SHALL pre-populate `globalThis.workflow = { name, env }` where `env` comes from `resolveEnvRecord(config.env, process.env)` before running the IIFE. `defineWorkflow` reads the same global consistently in both runtime and build-time contexts.

#### Scenario: Workflow defined with explicit name and env

- **WHEN** `defineWorkflow({ name: "cronitor", env: { URL: env({ default: "https://x" }) } })` is called inside the guest VM at invocation
- **THEN** the returned object SHALL have `name: "cronitor"` (from `globalThis.workflow.name`)
- **AND** SHALL have `env.URL: "<runtime-supplied value>"`
- **AND** SHALL be branded with `WORKFLOW_BRAND`

#### Scenario: Workflow defined with no config

- **WHEN** `defineWorkflow()` is called at invocation
- **THEN** the returned object SHALL be branded with `WORKFLOW_BRAND`
- **AND** SHALL have `name` equal to `globalThis.workflow.name` or `""` if absent
- **AND** SHALL have `env` equal to `globalThis.workflow.env` or `{}` if absent

#### Scenario: Multiple defineWorkflow calls in one file

- **GIVEN** a workflow file with two `defineWorkflow(...)` exports
- **WHEN** the build system processes the file
- **THEN** the build system SHALL fail with an error indicating "at most one defineWorkflow per file"

#### Scenario: Runtime env reflects build-time resolution

- **GIVEN** a workflow declaring `env: { TOKEN: env({ name: "TOKEN" }) }` and a build run with `process.env.TOKEN = "real_value"`
- **WHEN** the manifest is later loaded and the handler runs in the sandbox
- **THEN** `workflow.env.TOKEN` inside the handler SHALL equal `"real_value"`
- **AND** SHALL NOT equal any `default:` fallback

#### Scenario: defineWorkflow does not call resolveEnvRecord at runtime

- **GIVEN** the SDK's guest-side implementation of `defineWorkflow`
- **WHEN** the code path executed inside the QuickJS VM is inspected
- **THEN** there SHALL be no call to `resolveEnvRecord` or `getDefaultEnvSource` in the runtime path
- **AND** `resolveEnvRecord` SHALL remain used only from the Vite plugin's Node-VM discovery context

### Requirement: action factory returns typed callable

The `action(config)` export from the SDK SHALL produce a callable that, when invoked with input, calls `globalThis.__sdk.dispatchAction(config.name, input, config.handler)`. The callable SHALL return the result of that call. The SDK SHALL NOT construct a `completer` closure; output validation SHALL be performed host-side by the action-dispatch plugin via the host-call-action plugin's `validateActionOutput` export (per `sandbox-output-validation`). The SDK SHALL NOT contain any direct bridge logic, event emission, schema parsing, or lifecycle emission — all of that lives in the action-dispatch plugin's host-side handler and in the host-call-action plugin's schema validators.

```ts
// SDK implementation:
export const action = (config) => async (input) =>
  globalThis.__sdk.dispatchAction(
    config.name,
    input,
    config.handler,
  );
```

The `handler` callback SHALL be captured by the action-dispatch plugin as a `Callable` value (via `Guest.callable()`), invoked worker-side, and disposed in the plugin handler's `finally` block after each dispatch. The `config.outputSchema` object SHALL NOT cross the sandbox boundary at dispatch time — schema validators were rehydrated host-side at sandbox-construction time from the manifest's `outputSchema` entries (see `actions` "host-call-action plugin module").

Any extra positional argument that a stale tenant bundle passes as a fourth argument (legacy `(raw) => outputSchema.parse(raw)` completer) SHALL be silently ignored by the action-dispatch plugin handler; host-side validation runs regardless (per `sandbox-output-validation` stale-guest tolerance).

#### Scenario: action() calls __sdk.dispatchAction with three arguments

- **GIVEN** `action({ name: "myAction", handler: async (input) => input, outputSchema: z.object({ foo: z.string() }) })`
- **WHEN** the callable is invoked with `{ foo: "bar" }`
- **THEN** `globalThis.__sdk.dispatchAction("myAction", { foo: "bar" }, handler)` SHALL be called
- **AND** the SDK-bundled callable SHALL NOT pass a fourth positional argument
- **AND** the returned value SHALL be the resolved result from `__sdk.dispatchAction`

#### Scenario: SDK contains no direct event emission or legacy bridge references

- **GIVEN** the SDK source under `packages/sdk/src/`
- **WHEN** audited for calls to `__emitEvent`, `__hostCallAction`, or any other pre-plugin-architecture bridge global
- **THEN** no such calls SHALL exist

#### Scenario: outputSchema.parse is never constructed at dispatch time

- **GIVEN** the SDK source
- **WHEN** audited for closures of the shape `(raw) => outputSchema.parse(raw)` inside action callable construction
- **THEN** no such closure SHALL be constructed — output validation is host-side via the host-call-action plugin

### Requirement: One workflow per file

A workflow file SHALL declare at most one workflow. The vite-plugin SHALL identify the workflow's actions and triggers by walking the file's exports and matching brand symbols on the export values. Action and trigger identity SHALL equal the export name in the workflow file.

#### Scenario: Action identity is export name

- **GIVEN** `export const sendNotification = action({...})` in workflow file `cronitor.ts`
- **WHEN** the build system walks exports
- **THEN** the discovered action SHALL have `name: "sendNotification"`

#### Scenario: Renamed export updates identity

- **GIVEN** an exported action renamed from `sendNotification` to `notify`
- **WHEN** the build system walks exports
- **THEN** the discovered action SHALL have `name: "notify"`
- **AND** any code calling `await sendNotification(...)` SHALL be a TypeScript compile-time error

### Requirement: env() helper for environment references

The SDK SHALL export `env(opts?)` returning an `EnvRef` or `SecretEnvRef` depending on the `secret` flag. The opts SHALL accept:

- `name?: string` — the env var name; defaults to the key it's assigned to.
- `default?: string` — used when the env var is not set; INCOMPATIBLE with `secret: true`.
- `secret?: true` — marks the binding as a secret; rejected alongside `default` at the type level.

Function overloads SHALL make `env({ secret: true, default: "..." })` a TypeScript compile-time error.

`EnvRef`s SHALL be resolved at build time by the Vite plugin against `process.env` and written to `manifest.env`. `SecretEnvRef`s SHALL NOT be resolved at build time; instead, the plugin records the envName in `manifest.secretBindings: string[]`. The CLI fetches the server public key, seals each secret plaintext from its own `process.env` at upload, and rewrites the manifest to replace `secretBindings` with `secrets: Record<string, base64>` and `secretsKeyId: string`.

At invocation time, the runtime's secrets plugin decrypts `manifest.secrets` and merges the plaintexts into `workflow.env` alongside `manifest.env` values. Both secret and non-secret bindings appear as plain strings in `workflow.env`.

#### Scenario: env() defaults to key as name

- **GIVEN** `defineWorkflow({ env: { API_KEY: env() } })`
- **WHEN** the build resolves env
- **THEN** the plugin SHALL read `process.env.API_KEY` and write the value to `manifest.env.API_KEY`

#### Scenario: env() with explicit name

- **GIVEN** `defineWorkflow({ env: { url: env({ name: "MY_URL" }) } })`
- **WHEN** the build resolves env
- **THEN** the plugin SHALL read `process.env.MY_URL` and write the value to `manifest.env.url`

#### Scenario: env() with default

- **GIVEN** `defineWorkflow({ env: { URL: env({ default: "https://x" }) } })`
- **WHEN** `process.env.URL` is unset at build time
- **THEN** `manifest.env.URL` SHALL be `"https://x"`

#### Scenario: env() with secret true rejects default

- **GIVEN** `env({ name: "TOKEN", secret: true, default: "fallback" })`
- **WHEN** the workflow is type-checked
- **THEN** TypeScript SHALL emit a compile-time error

#### Scenario: env() with secret true routes to secretBindings

- **GIVEN** `defineWorkflow({ env: { TOKEN: env({ name: "TOKEN", secret: true }) } })`
- **WHEN** the build runs
- **THEN** `manifest.secretBindings` SHALL include `"TOKEN"`
- **AND** `manifest.env.TOKEN` SHALL NOT be present

#### Scenario: Secret value reaches runtime

- **GIVEN** `env({ name: "TOKEN", secret: true })` with `process.env.TOKEN = "ghp_xxx"` at CLI upload
- **WHEN** the CLI seals and the runtime decrypts per invocation
- **THEN** `workflow.env.TOKEN` inside the handler SHALL equal `"ghp_xxx"`

#### Scenario: Missing env without default fails build

- **GIVEN** `defineWorkflow({ env: { API_KEY: env() } })`
- **WHEN** `process.env.API_KEY` is unset and no default is provided
- **THEN** the build SHALL fail with `"Missing environment variable: API_KEY"`

#### Scenario: Missing secret env at CLI time fails upload

- **GIVEN** `env({ name: "TOKEN", secret: true })` and `process.env.TOKEN` is unset when `wfe upload` runs
- **WHEN** the CLI attempts to seal
- **THEN** upload SHALL fail with a clear error naming `TOKEN`

### Requirement: secret() export from SDK

The SDK SHALL export `secret(value: string): string`. The function SHALL invoke `globalThis.$secrets.addSecret(value)` and return `value` unchanged. Semantics:

- Adds `value` to the runtime's plaintext scrubber set.
- Subsequent outbound `WorkerToMain` messages SHALL have any literal occurrence of `value` replaced with `[secret]`.
- The call is a no-op if the runtime's secrets plugin is not active (e.g., in build-time Node-VM discovery where `globalThis.$secrets` may be absent); in that case, the function SHALL return `value` without throwing.

#### Scenario: secret called at runtime adds to scrubber

- **GIVEN** a handler that calls `secret("abc123")`
- **WHEN** the call completes
- **THEN** `globalThis.$secrets.addSecret("abc123")` SHALL have been invoked
- **AND** the return value SHALL equal `"abc123"`

#### Scenario: secret called at build-time Node VM is a no-op

- **GIVEN** the Vite plugin's Node-VM discovery context where `globalThis.$secrets` is undefined
- **WHEN** a workflow module evaluates `secret("x")` at top-level
- **THEN** the function SHALL return `"x"` without throwing
- **AND** no error SHALL be logged

### Requirement: Zod re-export

The SDK SHALL re-export the `z` namespace from Zod v4 for workflow authors. The SDK SHALL depend on `zod@^4.0.0`.

#### Scenario: Workflow author imports z from SDK

- **GIVEN** a workflow file that imports `z` from `@workflow-engine/sdk`
- **WHEN** the author uses `z.object(...)`, `z.string(...)`, etc.
- **THEN** these SHALL be Zod v4 functions

### Requirement: SDK provides subpath exports

The SDK package SHALL expose three entry points via the `exports` field in `package.json`:
- `"."` — DSL (defineWorkflow, action, httpTrigger, env, z, brands, type guards)
- `"./plugin"` — Vite plugin (`workflowPlugin` factory)
- `"./cli"` — Programmatic API (`build`, `upload`, `NoWorkflowsFoundError`)

The SDK SHALL NOT expose any sandbox plugin module via a subpath export. The runtime composes the sandbox plugin catalog from its own package; the SDK's role is workflow-author-facing only.

#### Scenario: Import DSL from root

- **WHEN** a module imports `{ defineWorkflow, z } from "@workflow-engine/sdk"`
- **THEN** it receives the workflow authoring DSL and Zod namespace

#### Scenario: Import plugin from subpath

- **WHEN** a module imports `{ workflowPlugin } from "@workflow-engine/sdk/plugin"`
- **THEN** it receives the Vite plugin factory function

#### Scenario: Import CLI API from subpath

- **WHEN** a module imports `{ build, upload } from "@workflow-engine/sdk/cli"`
- **THEN** it receives the programmatic build and upload functions

#### Scenario: SDK does not expose sandbox plugins

- **GIVEN** the `@workflow-engine/sdk` package
- **WHEN** a consumer attempts to resolve any sandbox-plugin subpath under `@workflow-engine/sdk`
- **THEN** package resolution SHALL fail (no matching `exports` entry)

### Requirement: SDK provides wfe binary

The SDK `package.json` SHALL declare a `bin` field mapping `wfe` to a compiled CLI entry point. The binary SHALL behave identically to the current `@workflow-engine/cli` `wfe` binary.

#### Scenario: Running wfe via pnpm

- **WHEN** a user runs `pnpm exec wfe upload`
- **THEN** the CLI builds workflows and uploads them, same as the previous standalone CLI package

### Requirement: SDK includes vite as regular dependency

The SDK SHALL list `vite` as a regular dependency (not a peer dependency). Workflow authors do not need to install vite separately.

#### Scenario: User installs only SDK

- **WHEN** a workflow project lists only `@workflow-engine/sdk` as a dependency
- **THEN** `pnpm install` resolves vite transitively without errors

### Requirement: SDK build step compiles CLI entry point

The SDK SHALL have a `build` script that compiles the CLI entry point (`src/cli/cli.ts`) to `dist/cli.js` with a Node.js shebang. This is the only compiled output; all other SDK source is consumed directly via TypeScript.

#### Scenario: Build produces CLI binary

- **WHEN** `pnpm build` runs in the SDK package
- **THEN** `dist/cli.js` exists with a `#!/usr/bin/env node` shebang

### Requirement: cronTrigger factory

The SDK SHALL export a `cronTrigger(config)` factory returning a callable `CronTrigger` value, following the same callable+branded pattern as `httpTrigger`. Full semantics are defined in the `cron-trigger` capability spec. This requirement exists in the `sdk` capability to establish that the factory is part of the SDK's public API surface and is re-exported alongside `httpTrigger` and `action`.

The SDK SHALL constrain the `schedule` field's TypeScript type using `ts-cron-validator`'s `validStandardCronExpression` template-literal type so that invalid cron expressions fail at compile time without executing runtime validation.

#### Scenario: cronTrigger exported from SDK root

- **WHEN** a workflow file imports `{ cronTrigger } from "@workflow-engine/sdk"`
- **THEN** the factory SHALL be available
- **AND** calling `cronTrigger({ schedule: "0 9 * * *", handler })` SHALL return a branded callable

#### Scenario: Invalid cron string fails at type level

- **GIVEN** `cronTrigger({ schedule: "invalid", handler: async () => {} })`
- **WHEN** the workflow file is type-checked
- **THEN** TypeScript SHALL reject the call with a type error on `schedule`

### Requirement: manualTrigger factory

The SDK SHALL export a `manualTrigger(config)` factory returning a callable `ManualTrigger` value, following the same callable+branded pattern as `httpTrigger` and `cronTrigger`. Full semantics are defined in the `manual-trigger` capability spec. This requirement exists in the `sdk` capability to establish that the factory is part of the SDK's public API surface and is re-exported alongside `httpTrigger`, `cronTrigger`, and `action`.

The factory config SHALL accept an optional `input` Zod schema, an optional `output` Zod schema, and a required `handler`. When `input` is omitted, the SDK factory SHALL use `z.object({})`; when `output` is omitted, the SDK factory SHALL use `z.unknown()`.

#### Scenario: manualTrigger exported from SDK root

- **WHEN** a workflow file imports `{ manualTrigger } from "@workflow-engine/sdk"`
- **THEN** the factory SHALL be available
- **AND** calling `manualTrigger({ handler: async () => {} })` SHALL return a branded callable

#### Scenario: manualTrigger exposes default schemas

- **GIVEN** `const t = manualTrigger({ handler: async () => {} })`
- **WHEN** `t.inputSchema` and `t.outputSchema` are inspected
- **THEN** `t.inputSchema` SHALL be `z.object({})` (or its structural equivalent)
- **AND** `t.outputSchema` SHALL be `z.unknown()` (or its structural equivalent)

#### Scenario: manualTrigger preserves author-provided schemas

- **GIVEN** `manualTrigger({ input: z.object({ id: z.string() }), output: z.number(), handler })`
- **WHEN** the returned value's schemas are inspected
- **THEN** `inputSchema` SHALL correspond to `z.object({ id: z.string() })`
- **AND** `outputSchema` SHALL correspond to `z.number()`

### Requirement: action() SDK export is a passthrough

The SDK's `action()` factory SHALL produce callables whose implementation is a thin wrapper calling `globalThis.__sdk.dispatchAction(name, input, handler)`. The wrapper SHALL NOT construct a `completer` closure; output validation SHALL be performed host-side by the `action-dispatch` plugin via the host-call-action plugin's `validateActionOutput` export. The SDK SHALL NOT reach into any other sandbox internals; all action-lifecycle logic lives in the `action-dispatch` plugin's worker-side handler.

#### Scenario: action() wraps dispatchAction

- **GIVEN** `action({ name: "myAction", input: z.object(...), output: z.object(...), handler: async (input) => input })`
- **WHEN** the callable is invoked with `await myAction({foo: "bar"})`
- **THEN** it SHALL call `globalThis.__sdk.dispatchAction("myAction", {foo: "bar"}, handler)`
- **AND** return the result
- **AND** it SHALL NOT pass any fourth positional argument

### Requirement: No runtime-appended dispatcher source

The runtime SHALL NOT append `action-dispatcher.js` (or any other dispatcher source) to tenant workflow bundles. All action-dispatcher logic lives in the runtime's `action-dispatch` plugin module (at `packages/runtime/src/plugins/action-dispatch.ts`, consumed via the `?sandbox-plugin` vite query). This is cross-referenced from `workflow-registry` (Sandbox loading) and `sandbox` (plugin composition) for runtime enforcement.

#### Scenario: Bundle loaded without source appending

- **GIVEN** a tenant workflow bundle produced by the vite plugin
- **WHEN** the runtime constructs the sandbox
- **THEN** `sandbox({source: <bundle>, plugins: [...]})` SHALL be invoked with `source` unchanged
- **AND** no dispatcher source SHALL be concatenated, prepended, or appended

### Requirement: sendMail export

The SDK SHALL export a named function `sendMail` from `@workflow-engine/sdk`. The function SHALL accept a single options object with required fields `smtp` (object with `host: string`, `port: number`, `tls: "tls" | "starttls" | "plaintext"`, `auth: { user: string, pass: string }`, optional `timeout: number`), `from: string`, `to: string | string[]`, `subject: string`, and optional fields `cc: string | string[]`, `bcc: string | string[]`, `replyTo: string | string[]`, `text: string`, `html: string`, `attachments: Array<{filename: string, content: Blob | File | Uint8Array | ArrayBuffer | string, contentType?: string}>`. The function SHALL normalize each attachment's `content` to a base64 string before invoking `globalThis.__mail.send`: `Blob` and `File` values SHALL be awaited via `arrayBuffer()` then base64-encoded; `Uint8Array` and `ArrayBuffer` values SHALL be base64-encoded directly; plain `string` values SHALL be interpreted as UTF-8 text content of the attachment and base64-encoded. The function SHALL otherwise pass the options object through to `__mail.send` unmodified; it SHALL NOT inspect, redact, or transform any field other than attachment content. The function SHALL return the resolved `{messageId: string, accepted: string[], rejected: string[]}` from the bridge, or throw the structured error envelope propagated from the bridge.

#### Scenario: Author imports and calls sendMail

- **GIVEN** an action handler that does `import { sendMail } from "@workflow-engine/sdk"`
- **WHEN** the action awaits `sendMail({ smtp, from, to, subject, text })` with a valid configuration
- **THEN** the call SHALL resolve to `{messageId, accepted, rejected}`

#### Scenario: Blob attachment is normalized to base64

- **GIVEN** the action passes `attachments: [{filename: "x.pdf", content: blob, contentType: "application/pdf"}]` where `blob` is a `Blob` instance
- **WHEN** `sendMail` invokes `__mail.send`
- **THEN** the bridged `attachments[0].content` SHALL be a base64 string
- **AND** the SDK SHALL NOT invoke `__mail.send` with a non-string `content`

#### Scenario: File attachment is normalized to base64

- **GIVEN** the action passes `attachments: [{filename: "x.pdf", content: file}]` where `file` is a `File` instance
- **WHEN** `sendMail` invokes `__mail.send`
- **THEN** the bridged `attachments[0].content` SHALL be a base64 string

#### Scenario: Uint8Array attachment is normalized to base64

- **GIVEN** the action passes `attachments: [{filename: "raw.bin", content: bytes}]` where `bytes` is a `Uint8Array`
- **WHEN** `sendMail` invokes `__mail.send`
- **THEN** the bridged `attachments[0].content` SHALL be a base64 string encoding those bytes

#### Scenario: ArrayBuffer attachment is normalized to base64

- **GIVEN** the action passes `attachments: [{filename: "raw.bin", content: buf}]` where `buf` is an `ArrayBuffer`
- **WHEN** `sendMail` invokes `__mail.send`
- **THEN** the bridged `attachments[0].content` SHALL be a base64 string encoding the buffer contents

#### Scenario: String attachment is interpreted as UTF-8 text

- **GIVEN** the action passes `attachments: [{filename: "note.txt", content: "hello", contentType: "text/plain"}]`
- **WHEN** `sendMail` invokes `__mail.send`
- **THEN** the bridged `attachments[0].content` SHALL be the base64 encoding of the UTF-8 bytes of `"hello"`

#### Scenario: SDK does not transform non-attachment fields

- **GIVEN** the action passes a valid `sendMail` options object with `smtp.auth.pass === "secret"`
- **WHEN** `sendMail` invokes `__mail.send`
- **THEN** the bridged `smtp.auth.pass` SHALL equal `"secret"` unchanged
- **AND** the SDK SHALL NOT log, redact, or modify `smtp`, `from`, `to`, `subject`, `text`, or `html`

#### Scenario: Structured error propagates unchanged

- **GIVEN** the host-side handler throws `{kind: "auth", code: 535, message: "auth failed", response: "535 5.7.8 ..."}`
- **WHEN** the SDK caller awaits `sendMail(...)`
- **THEN** the awaited promise SHALL reject with an error preserving `kind`, `code`, `message`, and `response`

### Requirement: SecretEnvRef build-time resolution emits sentinel strings

The SDK's build-time env resolver (`resolveEnvRecord` in `packages/sdk/src/index.ts`, invoked from `defineWorkflow`'s build-time branch when `globalThis.workflow` is absent) SHALL emit a sentinel string for every `SecretEnvRef` entry in `config.env` instead of skipping the entry.

The sentinel value SHALL be `encodeSentinel(ref.name ?? key)`, where `ref` is the `SecretEnvRef` object and `key` is its property key in `config.env`. The sentinel SHALL be imported from `@workflow-engine/core`'s `secret-sentinel` module; the SDK SHALL NOT inline the `\x00secret:NAME\x00` byte sequence.

After this change, at build time:

- Author code `wf.env.MY_SECRET` where `MY_SECRET: env({secret: true})` SHALL yield the string `encodeSentinel("MY_SECRET")`.
- Author code `` `Bearer ${wf.env.TOKEN}` `` SHALL yield a string whose value is `"Bearer "` concatenated with `encodeSentinel("TOKEN")`.
- Any such sentinel-bearing string passed as a trigger descriptor field SHALL be serialized into the manifest verbatim, with the sentinel bytes preserved.

The runtime behavior of `defineWorkflow` (reading `globalThis.workflow.env` installed by the secrets plugin, which contains plaintext for secret entries) SHALL be unchanged.

The effective binding name emitted into `manifest.secretBindings` (already `ref.name ?? key` today) SHALL be unchanged.

#### Scenario: Build-time access to a secret yields the sentinel string

- **GIVEN** a workflow `const wf = defineWorkflow({ env: { TOKEN: env({ secret: true }) } })` evaluated in the Vite plugin's Node VM with `process.env.TOKEN` unset
- **WHEN** the build code reads `wf.env.TOKEN`
- **THEN** the returned value SHALL equal `encodeSentinel("TOKEN")`
- **AND** the returned value SHALL be a `string`

#### Scenario: Build-time access to a secret with a name override

- **GIVEN** `defineWorkflow({ env: { LOCAL_KEY: env({ secret: true, name: "PROD_NAME" }) } })` evaluated at build time
- **WHEN** the build code reads `wf.env.LOCAL_KEY`
- **THEN** the returned value SHALL equal `encodeSentinel("PROD_NAME")`

#### Scenario: Runtime access to a secret yields plaintext (unchanged)

- **GIVEN** a workflow with `env: { TOKEN: env({ secret: true }) }` executing inside the sandbox after the secrets plugin has installed `globalThis.workflow = { name, env: { TOKEN: "real_value" } }`
- **WHEN** handler code reads `wf.env.TOKEN`
- **THEN** the returned value SHALL equal `"real_value"`

#### Scenario: Template-literal composition with a secret produces an embedded sentinel at build time

- **GIVEN** `const wf = defineWorkflow({ env: { SCHEDULE: env({ secret: true }) } })` at build time
- **WHEN** the build evaluates `` `every ${wf.env.SCHEDULE}` ``
- **THEN** the resulting string SHALL equal `"every " + encodeSentinel("SCHEDULE")`

#### Scenario: Trigger descriptor serialized with sentinel

- **GIVEN** a workflow at build time using `cronTrigger({ name: "tick", schedule: wf.env.SCHEDULE, tz: "UTC", handler: async () => {} })` where `SCHEDULE` is a `SecretEnvRef`
- **WHEN** the Vite plugin builds the manifest
- **THEN** `manifest.triggers[0].schedule` SHALL equal `encodeSentinel("SCHEDULE")`
- **AND** `manifest.secretBindings` SHALL contain `"SCHEDULE"`

### Requirement: executeSql export

The SDK SHALL export a named function `executeSql` from `@workflow-engine/sdk` with the signature:

```
executeSql(
  connection: Connection,
  query: string,
  params?: Param[],
  options?: { timeoutMs?: number },
): Promise<SqlResult>
```

`Connection` SHALL be the union `string | ConnectionObject`. When `connection` is a string, the SDK SHALL pass it through to the bridge as-is, treating it as a Postgres connection URI (e.g. `postgres://user:pass@host:port/db?sslmode=require`). `ConnectionObject` SHALL carry all of the optional fields `connectionString`, `host`, `port`, `user`, `password`, `database`, and `ssl`, mirroring the porsager/postgres `Options` shape. `ssl` SHALL be either `boolean` or an object accepting `ca`, `cert`, `key` (each a PEM `string`) and `rejectUnauthorized` (`boolean`). The SDK SHALL NOT merge, re-order, or precedence-override any of these fields — merging semantics are delegated to the underlying driver.

`Param` SHALL be the JSON-scalar union `string | number | boolean | null`. The SDK SHALL reject any other value type (`Date`, `Uint8Array`, `BigInt`, `Object`) at the call boundary before bridging. Authors requiring non-JSON types SHALL encode them at the call site (e.g. `Date.toISOString()`, base64 string, decimal string).

`SqlResult` SHALL have the shape `{rows: Row[], columns: ColumnMeta[], rowCount: number}`, where `Row` is `Record<string, SqlValue>`, `ColumnMeta` is `{name: string, dataTypeID: number}`, and `SqlValue` is the recursive JSON-safe union (`string | number | boolean | null | SqlValue[] | { [k: string]: SqlValue }`). The SDK SHALL NOT receive or construct `Date`, `Uint8Array`, `BigInt`, or any non-JSON value instance from the bridge.

`options.timeoutMs` SHALL be a positive integer number of milliseconds when provided. The SDK SHALL forward it to the bridge; the sandbox-stdlib SQL plugin is responsible for clamping and defaulting per the `createSqlPlugin` spec.

The function SHALL invoke the private `$sql/do` host-callable descriptor with the payload `{connection, query, params, options}` and SHALL resolve with the driver's JSON-safe result unchanged, or reject with the structured error envelope propagated from the bridge (`{message: string, code?: string}`).

#### Scenario: Author imports and calls executeSql

- **GIVEN** an action handler that does `import { executeSql } from "@workflow-engine/sdk"`
- **WHEN** the action awaits `executeSql("postgres://reader:pw@db.example.com/app?sslmode=require", "SELECT 1 AS x")` and the call succeeds
- **THEN** the call SHALL resolve to an object with `rowCount: 1`, `columns: [{name: "x", dataTypeID: <int4-oid>}]`, and `rows: [{x: 1}]`

#### Scenario: Parameterized query passes $N params through

- **GIVEN** the action calls `executeSql(conn, "SELECT $1::int AS n", [42])`
- **WHEN** the SDK invokes `$sql/do`
- **THEN** the bridged payload SHALL have `params: [42]`
- **AND** the bridged payload SHALL have `query: "SELECT $1::int AS n"` unchanged

#### Scenario: Connection-object form passes fields through

- **GIVEN** the action calls `executeSql({host: "db.example.com", port: 5432, user: "u", password: "p", database: "d", ssl: {ca: "-----BEGIN CERTIFICATE-----..."}}, "SELECT 1")`
- **WHEN** the SDK invokes `$sql/do`
- **THEN** the bridged `connection` object SHALL preserve every supplied field unchanged
- **AND** the SDK SHALL NOT merge, drop, or rewrite any connection field

#### Scenario: Unsupported param type is rejected

- **GIVEN** the action calls `executeSql(conn, "INSERT INTO t(at) VALUES ($1)", [new Date()])`
- **WHEN** the SDK validates params before bridging
- **THEN** the SDK SHALL throw a `TypeError` naming the offending type
- **AND** the SDK SHALL NOT invoke `$sql/do`

#### Scenario: Default options when timeoutMs omitted

- **GIVEN** the action calls `executeSql(conn, "SELECT 1")` with no `options` and no `params`
- **WHEN** the SDK invokes `$sql/do`
- **THEN** the bridged payload SHALL have `params: []` (or equivalent empty array)
- **AND** the bridged payload SHALL either omit `options` or pass `options: {}` — the plugin is responsible for defaults

#### Scenario: Rows returned are JSON-safe

- **GIVEN** a query whose result columns cover `int4`, `text`, `timestamptz`, `bytea`, `jsonb`
- **WHEN** the SDK returns the `SqlResult` to the author
- **THEN** every value in every row SHALL be one of `string`, `number`, `boolean`, `null`, `Array`, or plain `Object`
- **AND** no value SHALL be a `Date`, `Uint8Array`, `Buffer`, or `BigInt` instance

#### Scenario: Structured error propagates unchanged

- **GIVEN** the host-side handler throws `{message: "canceling statement due to statement timeout", code: "57014"}`
- **WHEN** the SDK caller awaits `executeSql(...)`
- **THEN** the awaited promise SHALL reject with an error preserving `message` and `code`

#### Scenario: SDK surface identity list

- **GIVEN** `workflows/src/demo.ts` statically references SDK identity symbols in its `_sdkSurface` block
- **WHEN** any future rename or removal of `executeSql` at the SDK boundary occurs
- **THEN** `pnpm build` on `demo.ts` SHALL fail with a type or reference error, preventing silent SDK drift

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

### Requirement: wsTrigger factory

The SDK SHALL export a `wsTrigger(config)` factory and its corresponding type guard `isWsTrigger(value): value is WsTrigger`. The factory returns a `WsTrigger` value branded with `Symbol.for("@workflow-engine/ws-trigger")` (exported as `WS_TRIGGER_BRAND`).

The config SHALL require:
- `request`: `ZodType` — schema for the inbound message data.
- `handler`: `(payload: { data: z.infer<typeof request> }) => Promise<z.infer<typeof response> | unknown>`.

The config SHALL accept optional:
- `response`: `ZodType` — schema for the handler return. When omitted, the SDK factory SHALL substitute `z.any()` (matching the optional-schema convention adopted for `action`, `manualTrigger`, and `httpTrigger.body`).

The returned value SHALL expose `request`, `response`, `inputSchema`, `outputSchema` as readonly own properties; the captured `handler` SHALL NOT be a public own property. `inputSchema` and `outputSchema` SHALL be the JSON Schemas derived from `request` and `response` respectively via `z.toJSONSchema()`.

The `Trigger` umbrella union exported from `@workflow-engine/sdk` SHALL be extended to include `WsTrigger` (see `triggers` capability).

#### Scenario: wsTrigger returns branded value

- **GIVEN** `const t = wsTrigger({ request: z.object({greet: z.string()}), handler: async ({data}) => ({echo: data.greet}) })`
- **WHEN** the value is inspected
- **THEN** `t[WS_TRIGGER_BRAND]` SHALL be `true`
- **AND** `isWsTrigger(t)` SHALL return `true`
- **AND** `t.request`, `t.response`, `t.inputSchema`, `t.outputSchema` SHALL be readonly own properties
- **AND** `t.handler` SHALL NOT be defined as an own property

#### Scenario: response defaults to z.any() when omitted

- **GIVEN** `const t = wsTrigger({ request: z.object({}), handler: async () => 'ok' })`
- **WHEN** the value is inspected
- **THEN** `t.response` SHALL be a `ZodAny` instance
- **AND** `t.outputSchema` SHALL be the JSON Schema for `z.any()` (i.e. `{}`)

#### Scenario: Build-time discovery via brand

- **GIVEN** a workflow file exporting both an `httpTrigger` and a `wsTrigger`
- **WHEN** `buildWorkflows()` discovers brand exports
- **THEN** the WS export SHALL be discovered via its `WS_TRIGGER_BRAND` symbol
- **AND** the resulting manifest SHALL contain a `type: "ws"` entry alongside the existing `type: "http"` entry

### Requirement: Trigger union includes WsTrigger

The SDK's exported `Trigger` umbrella type SHALL include `WsTrigger` as a union member. Consumers of `Trigger` (the workflow registry, manifest validation) SHALL handle the new union member.

#### Scenario: Trigger union covers all five kinds

- **WHEN** `Trigger` is inspected at the type level
- **THEN** the union SHALL equal `HttpTrigger | CronTrigger | ManualTrigger | ImapTrigger | WsTrigger`

### Requirement: defineQueue authoring primitive

The SDK SHALL export a `defineQueue` factory that accepts `{name?, schema}` and returns a brand-tagged `Queue<T>` handle whose members are `put(item: T, key?: string) => Promise<void>` and `get(key?: string) => Promise<T | undefined>`. The optional `key` names a partition **within** the queue: `put(item, key)` enqueues into that partition and `get(key)` pops FIFO from that partition only, never observing or removing items under another key. An omitted `key` SHALL resolve to the unkeyed partition (the empty string `''`); the SDK guest shim is the sole place that materializes this default, so a concrete `string` key crosses the host bridge on every call. `get()` SHALL be equivalent to `get('')`. The handle SHALL carry `Symbol.for("@workflow-engine/queue")` (`QUEUE_BRAND`) for build-time discovery. The SDK SHALL also export a matching `isQueue` type guard. `T` SHALL be inferred via `z.infer<typeof schema>`. The `name` argument SHALL be optional: when omitted, the workflow build pipeline derives the queue's name from the export identifier (matching the existing rule for `action` and `*Trigger`); when provided, the explicit value overrides the export name. The runtime identity used for storage is the resolved name (explicit or derived); the `key` is orthogonal to the queue's identity and is never part of the manifest.

#### Scenario: Author declares and uses a queue with derived name

- **WHEN** an author writes `export const jobs = defineQueue({schema: z.object({url: z.string().url()})});`
- **AND** within a trigger handler calls `await jobs.put({url: "https://example.com"})`
- **THEN** the manifest SHALL carry the queue under `name = "jobs"` (derived from the export identifier)
- **AND** `await jobs.get()` SHALL resolve with `{url: "https://example.com"}` on the next call

#### Scenario: Keyed put and get address one partition

- **WHEN** an author calls `await jobs.put({url: "https://a"}, "alice")` and `await jobs.put({url: "https://b"}, "bob")`
- **THEN** `await jobs.get("alice")` SHALL resolve with `{url: "https://a"}`
- **AND** `await jobs.get("bob")` SHALL resolve with `{url: "https://b"}`
- **AND** `await jobs.get()` (unkeyed) SHALL resolve with `undefined` (neither item is in the unkeyed partition)

#### Scenario: Explicit name overrides export identifier

- **WHEN** an author writes `export const jobs = defineQueue({name: "jobsV2", schema});`
- **THEN** the manifest entry SHALL carry `name = "jobsV2"`
- **AND** the resolved name `jobsV2` SHALL be used as the `queue` column value in `queue_items`

#### Scenario: Brand symbol enables build-time discovery

- **WHEN** the workflow build pipeline inspects an exported value
- **AND** the value carries `QUEUE_BRAND`
- **THEN** the pipeline SHALL treat the export as a queue declaration
- **AND** add a `{name, schema}` entry to the workflow's manifest

#### Scenario: isQueue type guard

- **WHEN** `isQueue(value)` is called on a brand-tagged queue handle
- **THEN** it SHALL return `true`
- **AND** narrow the value's type to `Queue<unknown>` for the caller

### Requirement: defineQueue handle is immutable

The handle returned by `defineQueue` SHALL be frozen. Authors MUST NOT be able to replace `put` or `get` after construction; doing so SHALL throw under strict mode or be a silent no-op outside it.

#### Scenario: Attempt to overwrite put

- **GIVEN** a queue handle `const q = defineQueue({...})`
- **WHEN** an author writes `q.put = somethingElse`
- **THEN** the assignment SHALL throw `TypeError` under strict mode (which the sandbox runs by default)

### Requirement: SDK is installable from the npm registry

The `@workflow-engine/sdk` package SHALL be installable via `npm install @workflow-engine/sdk` (or pnpm/yarn equivalents) from the public npm registry. After install, `npx wfe` SHALL invoke the `wfe` CLI from the installed package.

The package's `exports` field SHALL point at compiled JavaScript and TypeScript declaration files under `dist/`, not at TypeScript source under `src/`. The `files` field SHALL include `dist/` and any other artifacts required at install time.

The package's runtime dependencies SHALL NOT contain any `workspace:*` references in the published tarball. `pnpm publish` SHALL rewrite `workspace:*` to the concrete version of `@workflow-engine/core` published in the same job run.

The published `exports` map SHALL NOT include the `./sdk-support` entrypoint. `sdk-support` is a runtime-internal sandbox plugin module consumed via a workspace-relative path; it is not part of the author-facing surface.

#### Scenario: External author installs and uploads

- **GIVEN** an empty project with `package.json` and a `src/workflow.ts` that imports `defineWorkflow` from `@workflow-engine/sdk`
- **WHEN** the author runs `npm install @workflow-engine/sdk` followed by `npx wfe upload --owner <org> --token <PAT-with-read:org>`
- **THEN** the SDK SHALL build and upload the workflow against the configured runtime URL
- **AND** SHALL not require a checkout of the workflow-engine monorepo

#### Scenario: Published tarball contains compiled output, not source

- **WHEN** `npm pack @workflow-engine/sdk` is inspected
- **THEN** the tarball SHALL contain `dist/*.js` and `dist/*.d.ts` files
- **AND** the `exports` map SHALL resolve every entrypoint to a file under `dist/`

#### Scenario: Published tarball has concrete @workflow-engine/core version

- **WHEN** `npm view @workflow-engine/sdk dependencies` is inspected for any published version
- **THEN** the `@workflow-engine/core` dep SHALL be a concrete version string (e.g. `2026.5.1`)
- **AND** SHALL NOT be `workspace:*` or any non-resolvable specifier

#### Scenario: sdk-support is not exposed via the published exports map

- **WHEN** an external consumer attempts to import `@workflow-engine/sdk/sdk-support`
- **THEN** Node module resolution SHALL fail with no matching `exports` entry

### Requirement: `@workflow-engine/core` is published as a sibling

The `@workflow-engine/core` package SHALL be published to the npm registry alongside `@workflow-engine/sdk`. Its `package.json` SHALL declare `"private": false` (or omit the field) at publish time, with `exports` pointing at compiled output under `dist/`. The runtime continues to consume it via `workspace:*`; only the published artifact is materially affected.

The `@workflow-engine/sdk` package SHALL list `@workflow-engine/core` as a regular runtime dependency (not a peer dependency, not a dev dependency).

#### Scenario: core is published with sdk

- **WHEN** the publish job runs successfully for any version `$VERSION`
- **THEN** `@workflow-engine/core@$VERSION` SHALL be resolvable from the npm registry
- **AND** SHALL contain `dist/*.js` and `dist/*.d.ts` for every entrypoint declared in its `exports` map

### Requirement: Both packages declare a repository field for provenance

`@workflow-engine/sdk` and `@workflow-engine/core` SHALL each declare a `repository` field in their `package.json` matching the GitHub repository URL `https://github.com/stefanhoelzl/workflow-engine.git` (with the appropriate `directory` subpath). npm's `--provenance` validation rejects publishes whose `repository` does not match the GitHub Actions workflow's repository — without this field, the release publish job fails.

#### Scenario: Both packages have repository field at publish time

- **WHEN** the publish job invokes `npm publish --provenance` on either tarball
- **THEN** the tarball's `package.json` SHALL contain a `repository` field whose `url` resolves to the same GitHub repository as the workflow's `${{ github.repository }}`
- **AND** provenance validation SHALL succeed

### Requirement: Authoring requires a GitHub PAT with `read:org` scope

External authors uploading to a hosted runtime via `wfe upload --token <PAT>` SHALL provide a GitHub personal access token with the `read:org` scope (or, for fine-grained tokens, "Members: read" on the target organization).

The runtime authenticates the upload by calling GitHub's `/user` and `/user/orgs` endpoints to populate `user.orgs`, then enforcing `isMember(user, owner)` against the `AUTH_ALLOW` set. A token without `read:org` SHALL produce an empty `user.orgs`, causing the membership check to fail and the upload to receive a 404 response.

#### Scenario: Token without read:org fails membership check

- **GIVEN** a PAT scoped only to `repo` (no `read:org`)
- **WHEN** the author runs `wfe upload --owner <org> --token <PAT>`
- **THEN** the runtime SHALL respond with 404
- **AND** the response body SHALL not disclose whether the owner exists
