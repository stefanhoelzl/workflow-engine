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

The SDK SHALL export five brand symbols used to identify objects produced by its factories:
- `ACTION_BRAND = Symbol.for("@workflow-engine/action")`
- `HTTP_TRIGGER_BRAND = Symbol.for("@workflow-engine/http-trigger")`
- `CRON_TRIGGER_BRAND = Symbol.for("@workflow-engine/cron-trigger")`
- `MANUAL_TRIGGER_BRAND = Symbol.for("@workflow-engine/manual-trigger")`
- `WORKFLOW_BRAND = Symbol.for("@workflow-engine/workflow")`

The SDK SHALL provide type guards `isAction(value)`, `isHttpTrigger(value)`, `isCronTrigger(value)`, `isManualTrigger(value)`, `isWorkflow(value)` that check for the corresponding brand symbol.

#### Scenario: Brand on each factory return value

- **WHEN** `action(...)`, `httpTrigger(...)`, `cronTrigger(...)`, `manualTrigger(...)`, or `defineWorkflow(...)` is called
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

#### Scenario: isManualTrigger recognizes manual trigger values

- **GIVEN** a value `v` returned from `manualTrigger({...})`
- **WHEN** `isManualTrigger(v)` is called
- **THEN** the function SHALL return `true`
- **AND** `isHttpTrigger(v)` SHALL return `false`
- **AND** `isCronTrigger(v)` SHALL return `false`

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

The `action(config)` export from the SDK SHALL produce a callable that, when invoked with input, calls `globalThis.__sdk.dispatchAction(config.name, input, config.handler)`. The callable SHALL return the result of that call. The SDK SHALL NOT construct a `completer` closure; output validation SHALL be performed host-side by the sdk-support plugin via the host-call-action plugin's `validateActionOutput` export (per `sandbox-output-validation`). The SDK SHALL NOT contain any direct bridge logic, event emission, schema parsing, or lifecycle emission — all of that lives in the sdk-support plugin's host-side handler and in the host-call-action plugin's Ajv validators.

```ts
// SDK implementation:
export const action = (config) => async (input) =>
  globalThis.__sdk.dispatchAction(
    config.name,
    input,
    config.handler,
  );
```

The `handler` callback SHALL be captured by the sdk-support plugin as a `Callable` value (via `Guest.callable()`), invoked worker-side, and disposed in the plugin handler's `finally` block after each dispatch. The `config.outputSchema` object SHALL NOT cross the sandbox boundary at dispatch time — Ajv validators were compiled host-side at sandbox-construction time from the manifest's `outputSchema` entries (see `actions` "createHostCallActionPlugin factory").

Any extra positional argument that a stale tenant bundle passes as a fourth argument (legacy `(raw) => outputSchema.parse(raw)` completer) SHALL be silently ignored by the sdk-support plugin handler; host-side validation runs regardless (per `sandbox-output-validation` stale-guest tolerance).

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

The SDK package SHALL expose four entry points via the `exports` field in `package.json`:
- `"."` — DSL (defineWorkflow, action, httpTrigger, env, z, brands, type guards)
- `"./plugin"` — Vite plugin (`workflowPlugin` factory)
- `"./cli"` — Programmatic API (`build`, `upload`, `NoWorkflowsFoundError`)
- `"./sdk-support"` — Runtime-composed sandbox plugin factory (`createSdkSupportPlugin`). Consumed by the runtime's plugin composition; workflow authors do not import this.

#### Scenario: Import DSL from root

- **WHEN** a module imports `{ defineWorkflow, z } from "@workflow-engine/sdk"`
- **THEN** it receives the workflow authoring DSL and Zod namespace

#### Scenario: Import plugin from subpath

- **WHEN** a module imports `{ workflowPlugin } from "@workflow-engine/sdk/plugin"`
- **THEN** it receives the Vite plugin factory function

#### Scenario: Import CLI API from subpath

- **WHEN** a module imports `{ build, upload } from "@workflow-engine/sdk/cli"`
- **THEN** it receives the programmatic build and upload functions

#### Scenario: Import sandbox sdk-support plugin from subpath

- **WHEN** the runtime imports `{ createSdkSupportPlugin } from "@workflow-engine/sdk/sdk-support"`
- **THEN** it receives the plugin factory used to compose action-dispatch lifecycle into the sandbox

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

### Requirement: SDK exposes the sdk-support plugin module

The SDK package (`@workflow-engine/sdk`) SHALL expose the `sdk-support` plugin module via the `./sdk-support` subpath export, separately from its guest-facing root entrypoint. The module SHALL export the plugin's `name`, `dependsOn`, `worker`, and `guest` symbols (consumed by the `?sandbox-plugin` vite query when composing the production plugin catalog). The plugin encapsulates all action-dispatch lifecycle logic (previously in runtime's appended `action-dispatcher.js` source). Runtime compositions SHALL include this plugin. (Detailed plugin behavior: see sandbox-sdk-plugin capability.)

#### Scenario: SDK subpath exposes the plugin module

- **GIVEN** the `@workflow-engine/sdk` package
- **WHEN** a build-time consumer imports `@workflow-engine/sdk/sdk-support?sandbox-plugin` (or the TypeScript source directly, as `sandbox-store.ts` does)
- **THEN** the resulting plugin descriptor's `name` SHALL be `"sdk-support"`
- **AND** its `dependsOn` SHALL include `"host-call-action"`

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

### Requirement: sdk-support plugin shape

The SDK's `sdk-support` plugin module SHALL declare `dependsOn: ["host-call-action"]`, consuming both `validateAction` and `validateActionOutput` from the host-call-action plugin's exports.

The plugin SHALL register a private guest function descriptor `__sdkDispatchAction` with signature `(name: string, input: unknown, handler: Callable) => unknown`. The descriptor's `log` SHALL be `{ request: "action" }`, so the sandbox auto-wraps each call in an `action.request` / `action.response` / `action.error` frame. Within that wrap the handler SHALL:

1. Invoke `validateAction(name, input)` (via `deps["host-call-action"].validateAction`); on throw, the rejection propagates out of the auto-wrap and `action.error` fires.
2. Invoke the captured guest `handler(input)` callable, awaiting a raw value.
3. Invoke `validateActionOutput(name, raw)` on the host (via `deps["host-call-action"].validateActionOutput`) and return its validated result.
4. Dispose the captured `handler` in a `finally` block.

The dispatcher signature SHALL NOT accept a `completer` callable. Any extra positional argument passed by a stale guest SHALL be ignored; validation SHALL run host-side regardless. This keeps the security property intact even if a tenant bundle lags behind the new SDK shape (per `sandbox-output-validation`).

The plugin's `guest()` export (bundled as `descriptor.guestSource` by the vite plugin) SHALL install a locked `__sdk` object via `Object.defineProperty(globalThis, "__sdk", { value: Object.freeze({ dispatchAction: (name, input, handler) => raw(name, input, handler) }), writable: false, configurable: false, enumerable: false })` where `raw` is the captured `__sdkDispatchAction` private global. This is the canonical example of SECURITY.md §2 R-2 (locked host-callable global).

#### Scenario: __sdk.dispatchAction is the guest surface

- **GIVEN** a sandbox with the `sdk-support` plugin composed
- **WHEN** user source evaluates `typeof globalThis.__sdk.dispatchAction`
- **THEN** the result SHALL be `"function"`
- **AND** `typeof globalThis.__sdkDispatchAction` SHALL be `"undefined"`

#### Scenario: __sdk binding is locked

- **WHEN** user source evaluates `globalThis.__sdk = { dispatchAction: () => {} }`
- **THEN** the assignment SHALL throw in strict mode or silently no-op in sloppy mode
- **AND** `delete globalThis.__sdk` SHALL return false (non-configurable)

#### Scenario: __sdk object is frozen

- **WHEN** user source evaluates `globalThis.__sdk.dispatchAction = () => {}`
- **THEN** the assignment SHALL throw in strict mode or silently no-op in sloppy mode

#### Scenario: Successful action emits request/response with host-validated output

- **GIVEN** an action with input schema `{foo: string}` and input `{foo: "bar"}` whose handler returns `{result: 42}`
- **WHEN** `__sdk.dispatchAction("processOrder", {foo: "bar"}, handler)` is called
- **THEN** `action.request` SHALL be emitted with `createsFrame: true` and `input: {foo: "bar"}`
- **AND** `validateAction("processOrder", {foo: "bar"})` SHALL be invoked (no throw)
- **AND** the captured `handler` SHALL be invoked with `{foo: "bar"}`
- **AND** `validateActionOutput("processOrder", {result: 42})` SHALL be invoked host-side (no throw)
- **AND** `action.response` SHALL be emitted with `closesFrame: true` and `output: {result: 42}`
- **AND** `action.response.ref` SHALL equal `action.request.seq`

#### Scenario: Handler throws — action.error emitted

- **GIVEN** an action whose handler throws
- **WHEN** `__sdk.dispatchAction(...)` is called
- **THEN** `action.request` (createsFrame) SHALL fire first
- **AND** `action.error` SHALL be emitted with `closesFrame: true` and the serialized error
- **AND** the original error SHALL propagate back through `__sdk.dispatchAction`

#### Scenario: Input validation failure emits action.error

- **GIVEN** an action whose input fails Ajv validation
- **WHEN** `__sdk.dispatchAction(...)` is called
- **THEN** `action.request` SHALL fire with `createsFrame: true`
- **AND** `validateAction` SHALL throw
- **AND** `action.error` SHALL fire with `closesFrame: true` and the validation payload
- **AND** the guest `handler` SHALL NOT be invoked

#### Scenario: Output validation failure emits action.error

- **GIVEN** an action with output schema `z.string()` whose handler returns `42`
- **WHEN** `__sdk.dispatchAction(...)` is called
- **THEN** `action.request` SHALL fire with `createsFrame: true`
- **AND** the handler SHALL execute returning `42`
- **AND** `validateActionOutput` SHALL throw a ValidationError with `issues` on the host
- **AND** `action.error` SHALL fire with `closesFrame: true` and the validation payload
- **AND** the rejection SHALL propagate back before any value is returned

#### Scenario: Callable handler auto-disposed

- **GIVEN** an action dispatch where `handler` is captured as `Callable` via `Guest.callable()`
- **WHEN** the dispatch completes (success or failure)
- **THEN** `handler.dispose()` SHALL have been called exactly once

#### Scenario: Extra positional argument from a stale guest is ignored

- **GIVEN** a stale tenant bundle whose `action()` wrapper passes a fourth completer argument
- **WHEN** the dispatch fires
- **THEN** the plugin handler SHALL ignore the extra argument
- **AND** host-side `validateActionOutput(name, raw)` SHALL still run
- **AND** the dispatch outcome SHALL reflect only the host-side validator result

### Requirement: action() SDK export is a passthrough

The SDK's `action()` factory SHALL produce callables whose implementation is a thin wrapper calling `globalThis.__sdk.dispatchAction(name, input, handler)`. The wrapper SHALL NOT construct a `completer` closure; output validation SHALL be performed host-side by the `sdk-support` plugin via the host-call-action plugin's `validateActionOutput` export. The SDK SHALL NOT reach into any other sandbox internals; all action-lifecycle logic lives in the `sdk-support` plugin's worker-side handler.

#### Scenario: action() wraps dispatchAction

- **GIVEN** `action({ name: "myAction", input: z.object(...), output: z.object(...), handler: async (input) => input })`
- **WHEN** the callable is invoked with `await myAction({foo: "bar"})`
- **THEN** it SHALL call `globalThis.__sdk.dispatchAction("myAction", {foo: "bar"}, handler)`
- **AND** return the result
- **AND** it SHALL NOT pass any fourth positional argument

### Requirement: No runtime-appended dispatcher source

The runtime SHALL NOT append `action-dispatcher.js` (or any other dispatcher source) to tenant workflow bundles. All action-dispatcher logic lives in the SDK's `sdk-support` plugin module (at `packages/sdk/src/sdk-support/index.ts`, consumed via the `./sdk-support` subpath + `?sandbox-plugin` vite query). This is cross-referenced from `workflow-registry` (Sandbox loading) and `sandbox` (plugin composition) for runtime enforcement.

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
