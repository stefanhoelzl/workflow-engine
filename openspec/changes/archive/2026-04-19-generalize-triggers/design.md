## Context

Main has a metadata-only `WorkflowRegistry` (since the SandboxStore refactor) that owns tenant manifests + bundle sources and does HTTP URL-pattern matching via `lookup(tenant, workflow, path, method)`. The executor resolves sandboxes via `SandboxStore` and takes `(tenant, workflow, triggerName, payload, bundleSource)`. The manifest's single trigger kind — HTTP — carries a composite `schema` (body + headers + url + method + params + query) alongside its body/params/query JSON Schemas.

This refactor generalises the pipeline without shipping a second kind. The key move: split the registry's current HTTP-specific concerns into a pluggable `TriggerSource` per kind, make the executor kind-agnostic, and reshape the manifest to describe triggers via `inputSchema` + `outputSchema`.

## Goals / Non-Goals

**Goals:**

- A single file per kind (`packages/runtime/src/triggers/<kind>.ts`) owns the protocol adapter and lifecycle for that kind.
- Executor stays kind-agnostic — returns a discriminated `InvokeResult<T>` envelope, no HTTP shaping.
- `WorkflowRegistry` becomes the plugin host: sources register; registry pushes `reconfigure(kindView)` synchronously on every tenant change.
- SDK surface is unchanged for workflow authors.
- Shared `validate(descriptor, rawInput)` against `descriptor.inputSchema` replaces per-component Ajv validators.

**Non-Goals:**

- Ship cron/mail. The refactor's validity is proven by HTTP continuing to work under the new shape.
- Change the `/webhooks/<tenant>/<workflow>/<trigger-path>` URL or the tenant isolation model.
- Introduce dynamic plugin loading. Sources are statically registered in `main.ts`.
- Change the sandbox boundary, `SandboxStore`, or `InvocationEvent` shape.

## Decisions

### 1. Every trigger is a function `(input) => output`

Descriptors carry `inputSchema` + `outputSchema` + kind-specific fields. Sources translate native protocol events into `input` and translate `output` into the protocol's response.

- HTTP: `input = { body, headers, url, method, params, query }`, `output = HttpTriggerResult`.
- Cron (future): `input = { scheduledAt }`, `output = void`.
- Mail (future): `input = { from, to, subject, body, ... }`, `output` = ack.

**Alternatives rejected:** Per-kind payload typing throughout (today's shape); single uniform SDK `trigger({...})` entry point (loses HTTP's path-typed param inference).

### 2. `TriggerSource` is a long-lived interface with three methods

```ts
interface TriggerSource<K extends string> {
  readonly kind: K;
  start(): Promise<void>;
  stop(): Promise<void>;
  reconfigure(view: readonly TriggerViewEntry<K>[]): void;
}
```

`TriggerViewEntry<K>` carries `{ tenant, workflow, bundleSource, descriptor }` — pre-filtered by kind.

- HTTP source: `start`/`stop` are no-ops; middleware lives in the Hono chain. `reconfigure` rebuilds the URL-pattern map.
- Cron source (future): `start` spins up the scheduler; `stop` clears timers; `reconfigure` rebuilds the schedule set.

**Alternatives rejected:** Split Ingress + Translator; stateless `(event) => InvocationEvent` (doesn't fit scheduler loops).

### 3. Registry is the plugin host

`createWorkflowRegistry({ logger, storageBackend, sources })`. On every `registerTenant` / `recover` success, the registry rebuilds its internal descriptor view, partitions by `descriptor.kind`, and synchronously calls `source.reconfigure(kindSlice)` on each source before returning to the caller. No event-emitter, no subscriptions.

`registry.lookup()` is removed — HTTP routing moves into the HTTP source.

**Alternatives rejected:** Event-emitter + subscription (machinery + ordering windows); source-poll (latency during iteration); source-reads-on-every-dispatch (works for HTTP but not cron).

### 4. `executor.invoke(tenant, workflow, descriptor, input, bundleSource): Promise<InvokeResult<unknown>>`

The executor no longer knows about HTTP. It resolves the sandbox via `SandboxStore`, runs the handler, wires events to the bus, and returns a discriminated envelope:

```ts
type InvokeResult<T = unknown> =
  | { readonly ok: true; readonly output: T }
  | { readonly ok: false; readonly error: { message: string; stack?: string } };
```

Sources map the envelope to protocol responses (HTTP: 500 on `ok: false`; cron: log).

**Alternatives rejected:** Executor rethrows (moves event emission into every source); keep `HttpTriggerResult` error sentinel (couples executor to HTTP).

### 5. Shared validator against `descriptor.inputSchema`

```ts
validate(descriptor: TriggerDescriptor, rawInput: unknown):
  | { ok: true; input }
  | { ok: false; issues: ValidationIssue[] }
```

Sources assemble `rawInput` from their native event. HTTP source builds `{ body, headers, url, method, params, query }` from the real request, then calls `validate`. Single implementation, no per-kind duplication. Action-input validation at the host bridge remains separate (in `sandbox-store.ts`) — it validates per-action Zod schemas, not trigger inputs.

### 6. Manifest is BREAKING; event shape is untouched

```ts
// Before
{ name, type: "http", path, method, body, params, query?, schema }

// After
{ name, type: "http", path, method, body, params, query?, inputSchema, outputSchema }
```

SDK synthesises both — authors see no change. Existing tarballs become invalid; tenants re-upload. Matches the `multi-tenant-workflows` precedent.

`InvocationEvent` is unchanged — sources don't need to stamp kind on events; consumers that need kind resolve via `registry.list(tenant)` at read time (dashboard does this).

### 7. Per-kind file layout

```
packages/runtime/src/triggers/
  source.ts              # TriggerSource interface + TriggerViewEntry
  validator.ts           # Shared validate(descriptor, rawInput)
  http.ts                # createHttpTriggerSource (owns /webhooks/* + response shaping)
  http.test.ts
  validator.test.ts
  source.contract.test.ts  # Parameterised by kind — HTTP today
```

### 8. UI fires HTTP triggers via the webhook URL

The trigger UI still posts HTTP cards to the public webhook URL, not the new `/trigger/` endpoint — the HTTP source fills `headers/url/method/params/query` from the real HTTP request, so the user's form only needs to carry the body. Non-HTTP kinds (when they land) post to the kind-agnostic `POST /trigger/<tenant>/<workflow>/<trigger-name>` endpoint with the full inputSchema as the form.

Dashboard invocation rows resolve `triggerKind` from the registry at render time and show a per-kind glyph next to the workflow/trigger name.

## Data flow

### HTTP request path

```
request → httpSource.middleware
            ├─ parse URL (tenant, workflow, path)
            ├─ tenant regex check
            ├─ lookup descriptor in source's URL-pattern map
            ├─ parseBody (JSON)
            ├─ assemble rawInput { body, headers, url, method, params, query }
            ├─ validate(descriptor, rawInput) → { ok, input } | { ok: false, issues }
            │     ↳ on failure: 422 with issues
            ├─ executor.invoke(tenant, workflow, descriptor, input, bundleSource)
            │     ↳ SandboxStore.get → sandbox.run → { ok, output } | { ok: false, error }
            ├─ on ok: serialise output as HTTP response
            └─ on err: 500 internal_error
```

### Tenant upload path

```
registerTenant(tenant, files)
  ├─ validate manifest
  ├─ persist tarball (if backend)
  ├─ build TenantState (workflows + bundleSources + descriptors)
  └─ notifySources()
        for each source:
          source.reconfigure(descriptorsFilteredTo(source.kind))
```

### Startup

```
main.ts:
  executor = createExecutor({ bus, sandboxStore })
  httpSource = createHttpTriggerSource({ executor })
  await Promise.all(triggerSources.map(s => s.start()))
  registry = createWorkflowRegistry({ logger, sources: [httpSource], storageBackend })
  await registry.recover()
  app.use(httpSource.middleware)
  app.use(triggerMiddleware({ registry, executor }))   // UI
  ...
  // on shutdown:
  await Promise.allSettled(triggerSources.map(s => s.stop()))
  sandboxStore.dispose()
```

## Risks / Trade-offs

- **[Risk] Storage migration breaks existing deployments** → Mitigation: documented in `CLAUDE.md` Upgrade notes; wipe `workflows/` prefix; tenants re-upload.
- **[Risk] Shared validator can't cover HTTP-specific edge cases (URL encoding, missing Content-Type)** → Mitigation: HTTP source does protocol-level parsing (body reading, query extraction, headers → record) *before* calling `validate`. Protocol quirks stay in the source.
- **[Risk] Executor's new return type spreads through tests that asserted on `HttpTriggerResult`** → Mitigation: HTTP source owns the wrapping; ultimate HTTP response observable from end-to-end tests is unchanged.
- **[Trade-off] Registry-as-plugin-host couples the registry to the `TriggerSource` interface** → Accepted. The coupling is narrow (one `reconfigure` call in a loop), and the registry's role as the authoritative source of workflow state makes it the natural broker.
- **[Trade-off] HTTP source's middleware handler is long** → Accepted with `biome-ignore` justifications. The pipeline (parse URL → lookup → parseBody → validate → invoke → serialise) is inherently sequential; splitting fragments readability.

## Migration Plan

1. Add a bullet to `CLAUDE.md` Upgrade notes titled `generalize-triggers`:
   - Manifest: each trigger entry now requires `inputSchema` + `outputSchema` (replaces `schema`).
   - Executor API change: `invoke(tenant, workflow, descriptor, input, bundleSource) → InvokeResult<unknown>`.
   - Upgrade steps: (1) wipe `workflows/` prefix on the storage backend; (2) rebuild workflows with the new SDK; (3) re-upload each tenant via `wfe upload --tenant <name>`. `pending/` + `archive/` do NOT need to be wiped.
2. Workflow authors see no source change — the SDK continues to accept `httpTrigger({ path, method, body, query, handler })`.
3. **Rollback**: single revert of the refactor commit. Storage gets wiped again; no data-corruption path.

## Open Questions

None. All design branches were resolved during the earlier (pre-rebase) interview pass preserved in the branch history. Implementation-level choices (exact file names, internal helper shapes) deferred to the tasks phase.
