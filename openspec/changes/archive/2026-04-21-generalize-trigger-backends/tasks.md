## 1. Interface and shared types

- [x] 1.1 In `packages/runtime/src/triggers/source.ts`, replace the current `TriggerViewEntry` + `TriggerSource.reconfigure(view)` contract with: `TriggerEntry<D>` carrying only `{descriptor, fire}`; `ReconfigureResult` discriminated union; `TriggerConfigError` record; `TriggerSource<K, D>` with `kind`, `start()`, `stop()`, `reconfigure(tenant, entries): Promise<ReconfigureResult>`.
- [x] 1.2 Export the new types from the runtime package barrel.
- [x] 1.3 Add a non-generic `buildFire` helper (either co-located in `source.ts` or a new file `packages/runtime/src/triggers/build-fire.ts`) that takes `(executor, tenant, workflow, descriptor, bundleSource, validate)` and returns `(input: unknown) => Promise<InvokeResult<unknown>>`. Validate input against `descriptor.inputSchema` using the injected Ajv-wrapping `validate` function; on failure return `{ok: false, error: {message}}` without calling the executor.
- [x] 1.4 Write unit tests for `buildFire`: validation success routes to executor with the validated value; validation failure returns `{ok: false}` without touching the executor; executor rejection flows through unchanged.

## 2. WorkflowRegistry

- [x] 2.1 Change `WorkflowRegistry` construction to accept `backends: readonly TriggerSource[]` (renamed or aliased from today's `sources` parameter; keep one name — prefer `backends`).
- [x] 2.2 Compute `allowedKinds = new Set(backends.map(b => b.kind))` at construction; thread into the manifest parser so an unknown `trigger.type` fails manifest validation with a 422-worthy error naming the unsupported kind.
- [x] 2.3 Refactor `notifySources` into `reconfigureBackends(tenant, descriptors, workflow, bundleSource)`. For each backend, partition `descriptors` by `kind`, build one `TriggerEntry` per descriptor via `buildFire`, and call `backend.reconfigure(tenant, entries)`. Return a `Promise<AggregatedReconfigureResult>` that uses `Promise.allSettled` and classifies into `ok | userConfig | infra | both`.
- [x] 2.4 Integrate `reconfigureBackends` into `registerTenant`. Order: parse manifest → build entries + fire closures → reconfigure backends in parallel → on full success persist `workflows/<tenant>.tar.gz` → update in-memory tenant state. On any failure: skip persistence; do NOT roll back backends; return a classified failure result to the upload handler.
- [x] 2.5 Update `recover()` to call `registerTenant` with already-persisted bundles; this exercises the same reconfigure path. Keep today's "skip invalid tenants, log, continue" behavior on `recover()` — do not halt boot on a reconfigure failure.
- [x] 2.6 Remove the stale `WorkflowRegistry.lookup(tenant, method, path)` method and its spec-level scaffolding; the HTTP source owns its own routing. (Housekeeping — already gone in the runtime code per the exploration report; ensure no leftover types export it.)
- [x] 2.7 Write integration tests in `workflow-registry.test.ts`: parallel reconfigure across two stub backends; partial failure leaves HTTP at new state and tarball unwritten; manifest with unknown kind rejected before any backend is called; successful upload writes the tarball exactly once.

## 3. HTTP TriggerSource

- [x] 3.1 Rewrite `packages/runtime/src/triggers/http.ts` to the new contract. Internal state: `Map<tenant, TenantHttpState>` where `TenantHttpState` holds the URLPattern index + entries. `reconfigure(tenant, entries)` rebuilds `Map.get(tenant)` atomically; empty entries deletes the tenant key.
- [x] 3.2 Replace the source's `executor.invoke(...)` call with `entry.fire(normalizedInput)` where `normalizedInput` is the same `{body, headers, url, method, params, query}` shape produced today. Delete the source's import of the executor.
- [x] 3.3 Map the `InvokeResult` back into the HTTP response: `{ok: true, output}` → `serializeHttpResult(output)` (unchanged); `{ok: false, error}` where the error comes from input validation → `422` with validation details; `{ok: false, error}` from handler failure → `500` with `{error: "internal_error"}`.
- [x] 3.4 Make `reconfigure` return `Promise<ReconfigureResult>`. For today's routing model (pre-`fix-http-trigger-url`), detect cross-workflow conflicts within a single tenant's entries and return `{ok: false, errors: […]}` if found.
- [x] 3.5 Update `packages/runtime/src/triggers/http.test.ts`: assert the source no longer touches the executor; assert `reconfigure("acme", [])` clears only acme; assert conflict detection returns `{ok: false}` rather than throwing or logging silently.

## 4. Cron TriggerSource

- [x] 4.1 Rewrite `packages/runtime/src/triggers/cron.ts` to the new contract. Internal state: `Map<tenantKey, Set<entryState>>` with per-tenant cancellation on `reconfigure`. Today's global "cancel all, rebuild all" becomes "cancel tenant's timers, rebuild tenant's timers."
- [x] 4.2 Replace `executor.invoke(tenant, workflow, descriptor, {}, bundleSource)` at the firing site with `entry.fire({})`. Delete the source's executor import.
- [x] 4.3 Make `reconfigure` return `Promise<{ok: true}>` always (except on unexpected throws). Cron has no meaningful user-config error case at reconfigure time — invalid schedules are rejected earlier by the `@core` Zod schema.
- [x] 4.4 Update `packages/runtime/src/triggers/cron.test.ts`: per-tenant reconfigure isolation; `reconfigure("acme", [])` cancels only acme's timers; fire is invoked with `{}` and not `executor.invoke`; `stop()` still cancels across all tenants.

## 5. Trigger UI manual-fire integration

- [x] 5.1 Expose a read-only accessor on the cron (and HTTP, if applicable) source to resolve a `TriggerEntry` by `(tenant, workflow, triggerName)` so `/trigger`'s "Run now" action can call `entry.fire(input)` without going through the source's native protocol. (Implemented more cleanly on the registry itself as `getEntry(tenant, workflowName, triggerName)` — the UI has a single source of truth and doesn't need to know which backend owns a given kind.)
- [x] 5.2 Update the trigger UI code paths (currently calling `executor.invoke` directly for manual fires) to use the new accessor + `entry.fire`. This keeps the "manual fire bypasses the source's protocol but still goes through input validation" property.
- [x] 5.3 Add/update tests for the `/trigger` UI manual-fire path covering cron and HTTP.

## 6. Upload API error classification

- [x] 6.1 In `packages/runtime/src/api/upload.ts`, consume the `AggregatedReconfigureResult` from `registerTenant` and map to HTTP status + body per the `action-upload` spec: 422 for manifest failure (unchanged path), 400 for user-config errors (`{error: "trigger_config_failed", errors: [...]}`), 500 for infra errors (`{error: "trigger_backend_failed", errors: [...]}`), 400-with-both when both classes fire (include `infra_errors` side-channel).
- [x] 6.2 Ensure the persistence skip path is wired: `registerTenant` writes the tarball only on full success. Audit the upload handler for any pre-existing "persist first" fallback code and remove.
- [x] 6.3 Update `packages/runtime/src/api/upload.test.ts` for each response category, including a stub backend that returns `{ok: false}` and another that throws, both individually and together.

## 7. Main.ts and wiring

- [x] 7.1 In `packages/runtime/src/main.ts`, confirm the backends array is passed into the registry constructor under the new name (`backends:`). Ensure `await Promise.all([httpSource.start(), cronSource.start()])` still precedes `registry.recover()`.
- [x] 7.2 No new backend is added in this change; IMAP stays out of scope.

## 8. Documentation and security

- [x] 8.1 Update `CLAUDE.md` "Upgrade notes" with a new entry for `generalize-trigger-backends`: BREAKING internal runtime contract + BREAKING API response shape on failed upload; no tenant re-upload required; document the "failed uploads have no consistency guarantees" non-guarantee explicitly.
- [x] 8.2 Audit `SECURITY.md` §1 (tenant-isolation invariants) and §3 (webhook ingress) for any statement tied to the old `reconfigure(view)` contract; update wording where it references the backend calling the executor directly. The invariants themselves (no cross-tenant reach, no guest access to other tenants' fire closures) do not change.
- [x] 8.3 Note in `openspec/project.md` that the `TriggerSource` contract is now the stable plugin surface for adding new trigger kinds, and backends MUST NOT import the executor.

## 9. Validation and archive

- [x] 9.1 Run `pnpm validate` locally; fix any lint/type/test breakage.
- [x] 9.2 Run `pnpm exec openspec validate generalize-trigger-backends --strict` and resolve issues.
- [ ] 9.3 Open a PR; after merge, archive via `pnpm exec openspec archive generalize-trigger-backends`.
