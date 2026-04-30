# Workflow Automation Service

## Purpose

A lightweight workflow automation service for service wiring. Users author workflows as TypeScript projects that wire triggers to actions via direct typed function calls. User-provided action code runs in a sandboxed QuickJS WASM context (one sandbox per workflow). Trigger handlers compose actions as typed callable functions; for HTTP triggers the handler's return value IS the HTTP response (`{status?, body?, headers?}`). Cron and manual triggers return `Promise<unknown>`; the cron source discards the return value, and manual (trigger-UI / test) calls surface it to the caller.

## Tech Stack

- **Runtime**: Node.js (LTS)
- **Language**: TypeScript (strict mode)
- **Sandbox**: `quickjs-wasi` via `@workflow-engine/sandbox` — QuickJS WASM running inside a dedicated `worker_threads` Worker per sandbox instance. One sandbox per loaded workflow; reused across invocations; disposed on workflow unload.
- **HTTP**: Hono with `@hono/node-server`
- **Build**: Vite with Rolldown, invoked from inside the SDK CLI (`@workflow-engine/sdk/cli` → `buildWorkflows()`). `wfe build` emits per-workflow `dist/<name>.js`; the deployable tenant tarball is produced in-memory by `wfe upload` (sealed against the server pubkey) — no unsealed bundle ever hits disk
- **Schema/Types**: Zod v4 for action input/output and trigger payload schemas. Compile-time type inference via `z.infer<>`; runtime validation at trigger ingress (payload) and at the sandbox bridge (action input + output).
- **Manifest validation**: JSON Schema via Ajv on the host side (the manifest carries JSON Schema derived from Zod at build time).
- **Event Store**: DuckDB in-memory via `@duckdb/node-api` + Kysely query builder; indexes invocation lifecycle records.
- **Logging**: pino, structured JSON to stdout, wrapped behind app-owned `Logger` interface
- **Storage**: `StorageBackend` interface with filesystem and S3 implementations
- **Package Manager**: pnpm (workspace monorepo)
- **Dashboard**: Server-rendered HTML; jedison (JSON Schema forms) for the trigger UI

## Architecture Principles

- **Two primitives**: Trigger and Action. Triggers are entry points; actions are typed callable functions. Wiring is by direct typed function calls (`await sendNotification(input)`) inside the trigger handler — no events, no `emit()`, no `on:`, no fan-out at the engine level. Every trigger is uniformly shaped as `{ inputSchema, outputSchema, handler: (input) => output }`; the trigger's `TriggerSource` (per-kind protocol adapter in the runtime) translates the native protocol event (HTTP request, future cron tick, future email) to `input` and translates `output` back to the protocol's response.
- **Pluggable trigger backends**: one `TriggerSource` implementation per kind (currently `http`, `cron`, `manual`, `imap`, and `ws`). The `ws` backend additionally implements the `UpgradeProvider` interface — declared separately in `packages/runtime/src/triggers/source.ts` so future protocol adapters (WebTransport, raw TCP) can plug into the http server's `'upgrade'` event without bloating the trigger contract. Backends plug into the `WorkflowRegistry` as a plugin host; on every tenant upload the registry calls `reconfigure(tenant, entries)` on every backend in parallel (`Promise.allSettled`), where each `TriggerEntry` carries `{descriptor, fire}`. The `fire` closure is built by the registry via `buildFire` and encapsulates input-schema validation + `executor.invoke`; backends MUST NOT import or call the executor directly. `reconfigure` returns a discriminated `ReconfigureResult` — `{ok: true}` for success, `{ok: false, errors: TriggerConfigError[]}` for user-config failures (maps to 400 on upload API), and throws for infrastructure failures (maps to 500). The `TriggerSource` contract is the stable plugin surface for adding a new trigger kind: implement `{kind, start(), stop(), reconfigure(tenant, entries)}` in `packages/runtime/src/triggers/<kind>.ts` and append it to the `backends` array in `main.ts`. Every backend's `start()` is awaited during startup before `registry.recover()` runs (so `reconfigure` always sees a started backend), and every backend's `stop()` is awaited during shutdown before the sandbox store is disposed (so `reconfigure` never races with teardown).
- **Single source of truth**: `workflow.ts` defines all wiring. Each file is exactly one workflow; cross-references between actions and triggers are plain TypeScript imports/variables, refactor-safe.
- **One handler per trigger**: Each trigger declares exactly one handler. Intra-handler parallelism uses `Promise.all([a(x), b(x)])` where genuinely needed. No subscriber model.
- **Workflow-scoped isolation**: One QuickJS context per loaded workflow; reused across `invoke()` calls. Action handlers run inside the sandbox via the SDK-returned wrapper — the host bridge is reached once per action call for input validation + audit only; handler dispatch is in-sandbox (no nested `sandbox.run()`). Cross-workflow isolation is preserved by per-workflow sandbox instances.
- **Controlled host API**: Handler signatures are `(input)` for actions and `(payload)` for triggers — no `ctx` parameter. Workflow-level env is declared on `defineWorkflow({env})` and referenced via the imported `workflow.env` record (module-scoped, frozen at load time). Cross-action calls compile to `__sdk.dispatchAction(name, input, handler)` through the sdk-support plugin, which routes host-side `validateAction`/`validateActionOutput` via the host-call-action plugin's Ajv validators. Global `fetch()` is installed by the sandbox-stdlib web-platform plugin atop the fetch plugin's hardenedFetch default. No direct fs, net, process, or `require` access.
- **Per-workflow serialization**: Each workflow has a runQueue that serializes trigger invocations (one invocation at a time per workflow). Cross-workflow invocations run in parallel.
- **DuckLake-backed durable archive**: invocation events live in a DuckLake catalog (`<root>/events.duckdb`) plus partitioned Parquet data files (`<root>/events/main/events/owner=…/repo=…/`). EventStore buffers in-flight events in an in-memory accumulator and commits the full event list as one DuckLake transaction on terminal kinds (`trigger.response`, `trigger.error`, plus single-leaf kinds `trigger.exception` / `trigger.rejection` / `system.upload`). SIGKILL deliberately loses in-flight invocations (no per-event WAL); SIGTERM drains gracefully via synthetic `trigger.error{kind:"shutdown"}` terminals. Single-writer is a deployment contract enforced by `replicas: 1` + `Recreate` strategy in K8s.
- **Interface-first**: Storage is abstracted behind `StorageBackend` (FS and S3 implementations) with a typed `locator()` accessor that EventStore consumes to configure DuckLake's `ATTACH` and `CREATE SECRET` SQL. New backends are added by implementing the five-method interface; new consumers of invocation events do not exist by design — the executor calls EventStore directly.

## Project Conventions

### Code Style

Canonical source: `CLAUDE.md` §Code Conventions (enforced by `pnpm check` / `pnpm lint`). The list below is kept as a quick reference and MUST stay in sync with `CLAUDE.md`.

- Strict TypeScript with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- Named exports only. Separate `export type {}` from value exports.
- Factory functions over classes. Closures for private state.
- All relative imports use `.js` extensions (required by `verbatimModuleSyntax`).
- Use `z.exactOptional(...)` not `.optional()` for optional Zod fields.
- Explicit return types on all public functions.
- `biome-ignore` comments must have a justification suffix.

### Naming

- Action files / identifiers: camelCase; action identity = the exported name (`sendNotification`).
- Trigger identifiers: camelCase; trigger name = the exported name (`cronitorWebhook`).
- Workflow name: defaults to the file stem (`cronitor` from `cronitor.ts`); override with `defineWorkflow({name})`.
- Invocation IDs: prefixed with `evt_`.

### Error Handling

- Action handlers that throw → the surrounding trigger invocation is marked `failed`. The SDK wrapper (or the host bridge on input-validation failure) surfaces the error to the caller; Zod/Ajv `issues` arrays are preserved across the sandbox bridge.
- Trigger payload validation failure → 422 with structured Ajv issues before the sandbox is entered.
- Unmatched webhook path → 404.
- Trigger handler throw → 500 response + `failed` archive entry with the serialized error.
- Trigger handler return shape: `{status?, body?, headers?}` (defaults `200`, `""`, `{}`); each field optional.
- Runtime errors (bus pipeline failures, sandbox crashes) are logged via structured logging and surfaced through `Sandbox.onDied`.
- **`z.void()` is not supported as an action output schema** because neither `z.void()` nor `z.undefined()` have a JSON Schema representation (the vite-plugin's `z.toJSONSchema` pass rejects them). The v1 idiom for fire-and-forget / no-return actions is `z.unknown()`: it serializes to a valid (empty) JSON Schema, `parse(undefined)` returns `undefined`, and the handler can simply omit a return statement. This is the documented pattern; do not add an SDK shorthand for v1. See `openspec/specs/payload-validation/spec.md` and `openspec/specs/sdk/spec.md` for the authoritative contract.

### Testing Strategy

- **SDK tests** (`packages/sdk/`): brand assignment on returned objects, callable actions, env resolution + defaults, missing-without-default errors, manifest schema validation.
- **Vite plugin tests** (`packages/sdk/src/plugin/`): brand-based export discovery, name derivation (filestem + explicit), JSON Schema generation from Zod, build-failure cases (multiple `defineWorkflow`, missing schemas, missing handlers, typecheck failure).
- **Sandbox boundary tests** (`packages/sandbox/`): host-bridge surface inventory (only documented globals present; private plugin-descriptor names like `__sdkDispatchAction`, `__reportErrorHost`, `$fetch/do` auto-deleted at Phase 3), plugin composition + dependsOn topological sort, prototype-pollution payloads rejected, error serialization round-trips `issues`.
- **Runtime tests** (`packages/runtime/`): executor serialization per workflow; cross-workflow parallelism; EventStore commit-per-terminal against DuckLake; SIGTERM drain synthesises `trigger.error{kind:"shutdown"}` for any in-flight invocation; SIGKILL deliberately loses in-flight (no `pending/` WAL).
- **Integration tests**: workflow build → bundle load → registry register → webhook POST → executor.invoke → terminal commits to DuckLake → catalog round-trip.
- **Cross-package test**: SDK declaration → vite-plugin build → runtime load → executor invoke end-to-end with a fixture workflow.

## Domain Context

### Workflow Model

A **workflow** is a file (`workflows/*.ts`) exporting:

- Exactly one `defineWorkflow({name?, env?})` call as a module export — provides workflow-level config and a frozen `env` record derived from `process.env` at load time.
- Zero or more `action({input, output, handler})` calls exported under their author-chosen names. Input and output are Zod schemas; the bundler derives JSON Schema for the manifest.
- One or more trigger calls (`httpTrigger({body?, handler})`, `cronTrigger({schedule, tz, handler})`, `manualTrigger({input?, output?, handler})`) exported under their author-chosen names. Each trigger has exactly one handler; for HTTP triggers the return value is the HTTP response.

**SDK callable mechanism (not part of the manifest contract):** Action exports are typed callables (`await sendNotification({message: "..."})`); the author-facing ergonomic is SDK-internal and compiles to `__sdk.dispatchAction(name, input, handler)` (see the SDK bullet under Monorepo Structure). The manifest only serializes the action's `name` + JSON Schemas for `input` and `output`; HTTP-routing concerns (path, method, params, query) are resolved by the trigger middleware from the mechanical `/webhooks/<tenant>/<workflow>/<trigger-export-name>` URL and the native HTTP request — they are NOT manifest fields. The authoritative manifest schema lives in `@workflow-engine/core` (`ManifestSchema`) and is documented in `openspec/specs/workflow-manifest/spec.md`.

At build time the SDK CLI's `buildWorkflows()` discovers exports by **brand symbol check** on the export value (not by reference equality on the handler function — `defineWorkflow`, `action`, `httpTrigger`, `cronTrigger`, and `manualTrigger` return objects carrying `Symbol.for("@workflow-engine/<kind>")` brands). Action identity = export name. `wfe build` writes per-workflow `dist/<name>.js`; the deployable tarball (root `manifest.json` listing every discovered workflow + one `<name>.js` per workflow) is produced in-memory by `wfe upload` and POSTed once to `/api/workflows/<owner>/<repo>` — no unsealed bundle ever touches disk.

### Security Model

See `/SECURITY.md` for the authoritative threat model.

### Invocation Pipeline

A trigger invocation flows through the runtime as follows:

1. **HTTP request arrives** at `POST /webhooks/<tenant>/<workflow>/<trigger-path>` (public, unauthenticated — §3).
2. **Trigger middleware** (`packages/runtime/src/triggers/http.ts`) parses the JSON body, validates it against the trigger's JSON Schema (Ajv, compiled once per trigger at registry load), and builds the payload object `{body, headers, url, method, params, query}`. Validation failure → 422.
3. **`executor.invoke(tenant, workflow, triggerName, payload, bundleSource)`** is called. The executor routes through a per-`(tenant, workflow.sha)` `runQueue` so at most one invocation runs at a time against a given sandbox. Cross-workflow and cross-tenant invocations run in parallel.
4. **Sandbox handler dispatch**: the executor resolves a `Sandbox` via `sandboxStore.get(tenant, workflow, bundleSource)` (lazily constructed on first use and held for process lifetime per `(tenant, workflow.sha)`), then calls `sandbox.run("__trigger_<name>", payload, runOptions)`. Inside the sandbox, the trigger's handler runs; action calls reach the host bridge once for input validation + audit-log (the host does NOT dispatch the handler), then the SDK wrapper dispatches the author's handler in-sandbox and validates the return value against the output Zod schema.
5. **Lifecycle events**: the sandbox emits a `trigger.request` event at start and `trigger.response` / `trigger.error` at end; the executor's `sb.onEvent` receiver widens each with runtime metadata (`tenant`, `workflow`, `workflowSha`, `invocationId`, plus `meta.dispatch` on `trigger.request` only) and forwards via `await eventStore.record(event)`. EventStore buffers events in an in-memory accumulator keyed by invocation id; on terminal kinds (`trigger.response`, `trigger.error`, plus single-leaf kinds `trigger.exception` / `trigger.rejection` / `system.upload`) it commits the full event list as one DuckLake transaction. After each `record()` resolves, the executor emits the matching structured-log line (`invocation.started` / `invocation.completed` / `invocation.failed`) via `executor/log-lifecycle.ts` — independent of archive durability.
6. **HTTP response**: the trigger middleware takes the `HttpTriggerResult` returned by the handler (or constructs a 500 from the serialized error) and writes it to the Hono response.

Startup wires components in this order before binding the HTTP port: storage backend → EventStore (opens DuckLake catalog at `<root>/events.duckdb`; constant-time regardless of historical event count) → `SandboxFactory` → `SandboxStore` → executor (constructed with `eventStore` + `logger`) → trigger backends (all `start()`ed) → `WorkflowRegistry` + `registry.recover()` (reconfigures every started backend with persisted tenants) → HTTP server bind. There is no recovery scan — in-flight invocations on unclean termination (SIGKILL, OOM, force-delete) are deliberately lost; SIGTERM drains gracefully via synthetic `trigger.error{kind:"shutdown"}` terminals committed to DuckLake before exit.

Per-workflow serialization guarantees one-at-a-time handler execution per workflow (predictable sandbox state); cross-workflow parallelism preserves throughput.

## Infrastructure

- **IaC**: OpenTofu (HCL) with modular architecture
- **Local dev**: kind (Kubernetes IN Docker) cluster via `tehcyx/kind` provider
- **Reverse proxy**: Caddy as raw `kubernetes_manifest` resources (Deployment + Service + ConfigMap + PVC). One Caddy per cluster with a multi-site Caddyfile; built-in HTTP-01 ACME for prod/staging, `tls internal` for the local kind stack. No Helm, no Ingress CRDs, no cert-manager.
- **Auth**: in-app GitHub OAuth (`packages/runtime/src/auth/*`) — sealed session cookies on `/dashboard`/`/trigger`, Bearer tokens on `/api/*`, unified `AUTH_ALLOW` predicate
- **Local S3**: S2 (mojatter/s2-server) with filesystem backend for dev persistence
- **Image build**: Podman build via `terraform_data` local-exec, loaded into kind cluster

Module structure follows a strategy pattern — swappable implementations per capability (`kubernetes/kind`, `image/local`, `s3/s2`) with consistent output contracts, and a per-instance `app-instance` module composing app Deployment, Secrets, and inline NetworkPolicies. Cluster-level routing lives in `modules/caddy/`.

Infrastructure lives in `infrastructure/` with `modules/` (shared) and `local/` + `upcloud/` (environment roots).

## Monorepo Structure

```
packages/
├── core/             # @workflow-engine/core (shared contract types: manifest schemas, trigger payloads, event types, Zod v4 re-export)
├── sdk/              # @workflow-engine/sdk (authoring API + vite plugin + sdk-support plugin)
├── sandbox/          # @workflow-engine/sandbox (QuickJS host + plugin mechanism)
├── sandbox-stdlib/   # @workflow-engine/sandbox-stdlib (web-platform / fetch / timers / console plugins)
└── runtime/          # @workflow-engine/runtime (HTTP server + executor + registry + SandboxStore)
workflows/            # User-defined workflows (build target, not a package)
infrastructure/       # OpenTofu IaC (modules + local/persistence/cluster/prod/staging environments)
```

- **core**: Shared contract types consumed by both SDK (build-time) and runtime (load-time) without creating a circular dependency. Exports (from `packages/core/src/index.ts`): the manifest Zod validator `ManifestSchema` and its inferred types (`Manifest`, `WorkflowManifest`, `HttpTriggerManifest`, `CronTriggerManifest`, `ManualTriggerManifest`, `TriggerManifest`); HTTP trigger payload/result types (`HttpTriggerPayload`, `HttpTriggerResult`); event-bus types (`InvocationEvent`, `SandboxEvent`, `InvocationEventError`, `EventKind`, `DispatchMeta`); the action dispatch contract (`ActionDispatcher`, `dispatchAction`); the `IIFE_NAMESPACE` constant (`"__wfe_exports__"`); and a `z` re-export of Zod v4. Depends only on `zod` and `ajv`. A secondary subpath export (`@workflow-engine/core/test-utils`) provides `makeEvent()` for runtime-package unit tests; production code MUST NOT import it.
- **sdk**: Declarative authoring API — `defineWorkflow`, `action`, `httpTrigger`, `cronTrigger`, `manualTrigger`, `env()` helper, brand symbols (`WORKFLOW_BRAND`, `ACTION_BRAND`, `HTTP_TRIGGER_BRAND`, `CRON_TRIGGER_BRAND`, `MANUAL_TRIGGER_BRAND`) with matching type guards (`isWorkflow`, `isAction`, `isHttpTrigger`, `isCronTrigger`, `isManualTrigger`), SDK-local typed interfaces (`Workflow`, `Action`, `HttpTrigger`, `CronTrigger`, `ManualTrigger`, `Trigger`). The manifest Zod validator `ManifestSchema` and cross-cutting types (`HttpTriggerResult`, `HttpTriggerPayload`) live in `@workflow-engine/core`; the SDK imports and re-exports them so workflow authors have a single import surface. `z` is also re-exported (from core, from Zod v4). Action callables internally invoke `globalThis.__sdk.dispatchAction(name, input, handler)` — name is AST-injected by the workflow-build vite plugin; the locked `__sdk` global is installed by the sdk-support plugin (in SDK package), which wraps the private `__sdkDispatchAction` descriptor exported by that plugin's worker-side setup. Output validation is host-side via the host-call-action plugin's Ajv validators.
- **sdk/cli**: The `wfe` binary plus the programmatic CLI API. `buildWorkflows({cwd, workflows?})` is the in-memory core: discovers `defineWorkflow` / `action` / `httpTrigger` / `cronTrigger` / `manualTrigger` exports by brand symbol equality, resolves workflow name from `defineWorkflow({name})` or filestem, derives input/output JSON Schema from Zod via `z.toJSONSchema()`, enforces TypeScript type checking. Returns `{files: Map<name, js>, manifest: UnsealedManifest}`; writes nothing to disk. `wfe build` writes `dist/<name>.js` only. `wfe upload` calls the internal `bundle()` which seals secrets in-memory against the server pubkey via `@workflow-engine/core/secrets-crypto` and POSTs the tarball — no unsealed bundle ever hits disk. Fails the build on: zero-or-many `defineWorkflow` exports per file, missing schemas, missing handlers, duplicate or unnamed action exports, missing required env vars (plain or secret).
- **sandbox**: QuickJS WASM VM lifecycle running inside a dedicated `worker_threads` Worker per sandbox instance (host-bridge + QuickJS context live in the worker; main thread holds a thin proxy). VM-level globals from quickjs-wasi extensions (`URL`, `URLSearchParams`, `Headers`, `TextEncoder`, `TextDecoder`, `atob`, `btoa`, native `crypto.getRandomValues`, native `crypto.subtle`, native `DOMException`); every other guest-visible global is installed by a plugin from `sandbox-stdlib` (web-platform, fetch, timers, console) or by runtime/sdk plugins (trigger, host-call-action, sdk-support, wasi-telemetry). Public API: `sandbox({source, plugins, filename?, memoryLimit?, logger?}) → { run, dispose, onDied }` and `createSandboxFactory({ logger })`. JSON-only host/sandbox boundary; cancel-on-run-end for timers and in-flight fetches.
- **runtime**: HTTP server (Hono), workflow registry (metadata-only; owns per-tenant workflow manifests + bundle sources; `registerTenant(tenant, files, {tarballBytes})` persists `workflows/<tenant>.tar.gz` and atomically replaces the tenant's metadata; backend-plugin host for `TriggerSource` implementations), sandbox store (keyed by `(tenant, workflow.sha)`; lazily constructs sandboxes on first use via the sandbox factory, composes the production plugin catalog, importing each plugin module via the `?sandbox-plugin` vite query and spreading the `host-call-action` descriptor together with Ajv validator sources compiled on the main thread via `compileActionValidators(manifest)`, holds sandboxes for process lifetime — no eviction, re-upload orphans the old sandbox for any in-flight invocation; stamps `tenant`/`workflow`/`workflowSha`/`invocationId` on every event via `onEvent`), executor (per-`(tenant, workflow.sha)` runQueue, resolves sandbox via store, dispatches via `sandbox.run`, stamps `meta.dispatch` on `trigger.request` events only, calls `eventStore.record(event)` on every emitted lifecycle event, then emits `invocation.started` / `.completed` / `.failed` log lines via `executor/log-lifecycle.ts`), EventStore (DuckLake-backed durable archive — catalog DB at `<root>/events.duckdb` plus partitioned Parquet, accumulator-buffered in RAM until terminal commit, retry-then-drop on commit failure, background CHECKPOINT timer), HTTP trigger middleware (parses mechanical `/webhooks/<tenant>/<workflow>/<export-name>` URL, delegates to fire closure), trigger UI (`/trigger/*`, authenticated, server-synthesizes `HttpTriggerPayload` for HTTP descriptors), API (`/api/*` including `POST /api/workflows/<tenant>` upload behind `requireTenantMember()`), startup wiring (`main.ts` constructs the executor, starts every `TriggerSource` backend, then boots the registry from storage which reconfigures the started backends, then binds the HTTP server — no recovery scan: in-flight invocations on unclean termination are deliberately lost). No event-bus, no scheduler, no event-source, no work-queue, no context module, no `WorkflowRunner` abstraction.
- **workflows**: Workspace member containing user-authored `.ts` workflow files. Built by the vite-plugin into a single tenant tarball `workflows/dist/bundle.tar.gz` containing a root `manifest.json` (`{ workflows: [...] }`) plus one `<name>.js` per workflow at the tarball root.

## Important Constraints

- **Single instance**: One service instance runs all loaded workflows. Components are factory-constructed objects for future multi-instance support.
- **No hot-reload**: Restart the service (or re-POST `/api/workflows`) to deploy workflow updates.
- **No retry in v1**: Failed invocations are archived with `status: failed` and a serialized error; no auto-retry, no operator retry UI. SIGKILL during an in-flight invocation loses it entirely (the in-memory accumulator is RAM-only); SIGTERM drains gracefully via a synthetic `trigger.error{kind:"shutdown"}` terminal — the runtime does NOT re-run dropped invocations.
- **No cross-workflow action calls**: each workflow is a sealed unit (own sandbox, own env, own bundle).
- **JSON only**: All data crossing the sandbox boundary must be JSON-serializable. Trigger payloads and action input/output marshaling are JSON round-trips. Host object references, closures, and proxies never cross.
- **Resource limits deferred**: QuickJS supports memory limits and interrupt handlers, but neither is wired in v1.
- **Determinism polyfills deferred**: `Math.random` and `Date.now` are not virtualized in v1. When durable execution / replay lands, these move behind the bridge.

## External Dependencies

- `quickjs-wasi` + `@jitl/quickjs-wasmfile-release-sync` — QuickJS WASM sandbox
- `zod` (v4) — Schema definition, type inference, and runtime validation
- `ajv` — JSON Schema validation on the host side (manifest-sourced schemas)
- `vite` — Build tooling with Rolldown bundler
- `hono` + `@hono/node-server` — HTTP server framework
- `@duckdb/node-api` + `kysely` — In-memory invocation index and query builder
- `pino` — Structured JSON logging
- `@aws-sdk/client-s3` — S3 storage backend
- `jedison` — JSON Schema forms for the trigger UI
