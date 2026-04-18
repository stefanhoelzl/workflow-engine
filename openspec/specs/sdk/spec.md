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

The SDK SHALL export three brand symbols used to identify objects produced by its factories:
- `ACTION_BRAND = Symbol.for("@workflow-engine/action")`
- `HTTP_TRIGGER_BRAND = Symbol.for("@workflow-engine/http-trigger")`
- `WORKFLOW_BRAND = Symbol.for("@workflow-engine/workflow")`

The SDK SHALL provide type guards `isAction(value)`, `isHttpTrigger(value)`, `isWorkflow(value)` that check for the corresponding brand symbol.

#### Scenario: Brand on each factory return value

- **WHEN** `action(...)`, `httpTrigger(...)`, or `defineWorkflow(...)` is called
- **THEN** the returned value SHALL have the corresponding brand symbol set to `true`

#### Scenario: Type guard recognizes branded value

- **GIVEN** a value `v` returned from `action({...})`
- **WHEN** `isAction(v)` is called
- **THEN** the function SHALL return `true`

#### Scenario: Type guard rejects unrelated value

- **GIVEN** a plain function `() => 1`
- **WHEN** `isAction(value)` is called
- **THEN** the function SHALL return `false`

### Requirement: defineWorkflow factory

The SDK SHALL export `defineWorkflow(config)` returning a `Workflow` object branded with `WORKFLOW_BRAND`. The config SHALL accept optional `name?: string` and optional `env?: Record<string, string | EnvRef>`. When `name` is omitted, the build system SHALL derive the workflow name from the file's filestem. The returned `Workflow.env` SHALL be a `Readonly<Record<string, string>>` with `EnvRef`s resolved at build time.

#### Scenario: Workflow defined with explicit name and env

- **WHEN** `defineWorkflow({ name: "cronitor", env: { URL: env({ default: "https://x" }) } })` is called
- **THEN** the returned object SHALL have `name: "cronitor"`
- **AND** SHALL have `env.URL: "https://x"`
- **AND** SHALL be branded with `WORKFLOW_BRAND`

#### Scenario: Workflow defined with no config

- **WHEN** `defineWorkflow()` is called
- **THEN** the returned object SHALL be branded with `WORKFLOW_BRAND`
- **AND** SHALL have `name: undefined` (build system fills in filestem)
- **AND** SHALL have `env: {}`

#### Scenario: Multiple defineWorkflow calls in one file

- **GIVEN** a workflow file with two `defineWorkflow(...)` exports
- **WHEN** the build system processes the file
- **THEN** the build system SHALL fail with an error indicating "at most one defineWorkflow per file"

### Requirement: action factory returns typed callable

The SDK SHALL export `action({ input, output, handler, name })` returning an `Action<I, O>` object that is BOTH branded with `ACTION_BRAND` AND callable as `(input: I) => Promise<O>`. The `name` field SHALL be a required `string` carrying the action's identity (used for dispatcher routing, host-side input validation, and audit logging). The returned callable's body SHALL invoke the runtime-installed action dispatcher via the `dispatchAction()` helper exported from `@workflow-engine/core`; `dispatchAction()` SHALL read `globalThis.__dispatchAction` and invoke it with `(name, input, handler, outputSchema)`. The dispatcher (installed by the runtime and locked as non-writable, non-configurable — see `sandbox` capability) SHALL reach the host-side `__hostCallAction` bridge for input validation, invoke the handler in the same QuickJS context, validate the return value against the output schema, and emit `action.*` lifecycle events via the captured `__emitEvent` reference.

The captured `handler` reference SHALL NOT be exposed as a public property on the returned `Action` value — the only path to invoke the handler SHALL be through the callable itself, which routes through the dispatcher. Guest code SHALL NOT be able to call the handler directly to bypass `__hostCallAction` audit logging.

The vite-plugin SHALL inject `name` into each `action({...})` call expression at build time (see `vite-plugin` capability). When `action({...})` is constructed without a `name` (e.g., in a hand-rolled bundle that did not go through the plugin), the callable SHALL throw `"Action constructed without a name; pass name explicitly or build via @workflow-engine/sdk/plugin"` on first invocation.

The config SHALL require:
- `input`: `z.ZodType<I>` --- Zod schema validating action input
- `output`: `z.ZodType<O>` --- Zod schema validating action output
- `handler`: `(input: I) => Promise<O>` --- async handler function
- `name`: `string` --- the action's identity (typically injected by the vite-plugin)

#### Scenario: Action handle is callable and branded

- **GIVEN** `const send = action({ input, output, handler, name: "send" })`
- **WHEN** the value is inspected
- **THEN** `send` SHALL be a function (callable)
- **AND** `send[ACTION_BRAND]` SHALL be `true`
- **AND** `send.input`, `send.output`, `send.name` SHALL be exposed as readonly properties
- **AND** `send.handler` SHALL NOT be defined as an own property

#### Scenario: TypeScript infers input/output from schemas

- **GIVEN** `const a = action({ input: z.object({ x: z.number() }), output: z.string(), handler: ..., name: "a" })`
- **WHEN** `await a({ x: 1 })` is called
- **THEN** TypeScript SHALL accept the call and infer the result as `Promise<string>`
- **AND** `await a({ x: "wrong" })` SHALL be a TypeScript compile-time error

#### Scenario: Callable dispatches via __dispatchAction

- **GIVEN** an action callable inside a sandbox where the runtime-appended dispatcher shim has installed `__dispatchAction`
- **WHEN** the callable is invoked with a valid input
- **THEN** the callable SHALL reach `globalThis.__dispatchAction(name, input, handler, outputSchema)` via `core.dispatchAction()`
- **AND** the dispatcher SHALL run input validation, invoke the handler, and validate the output before returning the validated result to the caller

#### Scenario: Action constructed without a name throws on invocation

- **GIVEN** a hand-rolled call `const orphan = action({ input, output, handler })` with no `name` field
- **WHEN** `await orphan({...})` is called
- **THEN** the call SHALL throw with message "Action constructed without a name; pass name explicitly or build via @workflow-engine/sdk/plugin"

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

The SDK SHALL export `env(opts?)` returning an `EnvRef` placeholder used in `defineWorkflow({ env })`. The opts SHALL accept optional `name?: string` (the env var name; defaults to the key it's assigned to) and optional `default?: string` (used when the env var is not set).

#### Scenario: env() defaults to key as name

- **GIVEN** `defineWorkflow({ env: { API_KEY: env() } })`
- **WHEN** the build resolves env
- **THEN** the runtime SHALL read `process.env.API_KEY`

#### Scenario: env() with explicit name

- **GIVEN** `defineWorkflow({ env: { url: env({ name: "MY_URL" }) } })`
- **WHEN** the build resolves env
- **THEN** the runtime SHALL read `process.env.MY_URL` and assign it to `workflow.env.url`

#### Scenario: env() with default

- **GIVEN** `defineWorkflow({ env: { URL: env({ default: "https://x" }) } })`
- **WHEN** `process.env.URL` is unset
- **THEN** `workflow.env.URL` SHALL be `"https://x"`

#### Scenario: Missing env without default fails build

- **GIVEN** `defineWorkflow({ env: { API_KEY: env() } })`
- **WHEN** `process.env.API_KEY` is unset and no default is provided
- **THEN** the build SHALL fail with `"Missing environment variable: API_KEY"`

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

#### Scenario: Import DSL from root

- **WHEN** a module imports `{ defineWorkflow, z } from "@workflow-engine/sdk"`
- **THEN** it receives the workflow authoring DSL and Zod namespace

#### Scenario: Import plugin from subpath

- **WHEN** a module imports `{ workflowPlugin } from "@workflow-engine/sdk/plugin"`
- **THEN** it receives the Vite plugin factory function

#### Scenario: Import CLI API from subpath

- **WHEN** a module imports `{ build, upload } from "@workflow-engine/sdk/cli"`
- **THEN** it receives the programmatic build and upload functions

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
