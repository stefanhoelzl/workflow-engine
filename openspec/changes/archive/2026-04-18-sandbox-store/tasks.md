## 1. Sandbox package: reduce factory to construction-only

- [x] 1.1 In `packages/sandbox/src/factory.ts`, remove the `cache: Map<string, Sandbox>` and all cache-hit / cache-miss branches. `create(source, options)` SHALL always call `sandbox(source, {}, { ...options, logger })` and return the result.
- [x] 1.2 Remove the `onDied` → cache-evict registration from `create`. Each returned `Sandbox` still exposes `onDied`; consumers attach if they want. The factory does not.
- [x] 1.3 Add a `Set<Sandbox>` of created instances (for `dispose()` fan-out). Each returned sandbox gets an `onDied` handler that removes it from the set so `dispose()` doesn't double-dispose dead workers. This is internal only.
- [x] 1.4 Rewrite `dispose()` to iterate the tracked set, call `sb.dispose()` on each, emit the `info` log with `reason: "factory.dispose"`, and clear the set.
- [x] 1.5 Remove `packages/sandbox/src/factory.test.ts` test cases that assert cache behavior: "subsequent call reuses cached instance", "dead sandbox is evicted", "create after dispose spawns fresh on previously-cached source" — replace with: "every create constructs a new Sandbox", "dispose tears down all created sandboxes", "create after dispose spawns fresh".
- [x] 1.6 Leave `Factory propagates its Logger into constructed sandboxes` and logger-related tests untouched.

## 2. Runtime package: introduce `SandboxStore`

- [x] 2.1 Create `packages/runtime/src/sandbox-store.ts` exporting `createSandboxStore({ sandboxFactory, logger })` → `SandboxStore` with the `get` + `dispose` surface defined in `specs/sandbox-store/spec.md`.
- [x] 2.2 Move per-workflow sandbox construction recipe into the store: Ajv input-validator compilation per action, `__hostCallAction` closure construction, sandbox source assembly (bundle + `ACTION_DISPATCHER_SOURCE` + action-name binder + trigger shim), call to `sandboxFactory.create(source, { methods: { __hostCallAction }, filename, methodEventNames })`. Port the relevant helpers from `workflow-registry.ts`.
- [x] 2.3 Key the internal `Map<string, Promise<Sandbox>>` on `${tenant}/${workflow.sha}`. Store in-flight promises (not resolved sandboxes) so two concurrent `get` calls with the same key share one construction.
- [x] 2.4 On `get` miss: construct, insert the promise, await it, return. On `get` hit: return the cached promise.
- [x] 2.5 Implement `dispose()` to iterate all cached sandboxes and call `sb.dispose()` on each; clear the map.
- [x] 2.6 Add `packages/runtime/src/sandbox-store.test.ts` covering: first get constructs, second get reuses, different tenants with same sha are distinct, different shas within a tenant are distinct, concurrent gets for the same key share construction, `dispose()` tears down all cached sandboxes, `__hostCallAction` closure is wired and receives Ajv-validated input on invocation.
- [x] 2.7 Add a test: "in-flight invocation completes on the orphaned sandbox after re-upload." Two gets (old sha, new sha) for the same tenant; start an invocation on the old-sha sandbox; while in-flight, call get with new sha; the in-flight invocation completes on the old sandbox, and the old sandbox remains in the cache (not disposed).

## 3. Runtime package: rewrite `WorkflowRegistry` as metadata-only

- [x] 3.1 In `packages/runtime/src/workflow-registry.ts`, delete `WorkflowRunner` construction (`buildRunner`, `buildInvokeHandler`, `buildSandboxSource`, `buildTriggerShim`, `buildActionNameBinder`, `ACTION_DISPATCHER_SOURCE`, `buildHostCallAction`). These move to `sandbox-store.ts` (see task 2.2).
- [x] 3.2 Delete the `runners[]`, `runnersByKey`, `lifetimes`, `retiringLifetimes`, `addRunner`, `removeRunner`, `swapTenantRunners` machinery. The registry no longer owns sandboxes or runners.
- [x] 3.3 Add per-tenant in-memory metadata: `Map<tenant, TenantState>` where `TenantState = { workflows: Map<name, WorkflowManifest>, bundleSources: Map<name, string>, triggerIndex: TenantTriggerIndex }`.
- [x] 3.4 Implement `lookup(tenant, method, path)` returning `{ workflow, triggerName, validator } | undefined`. Use the per-tenant `triggerIndex` for routing.
- [x] 3.5 Keep `registerTenant(tenant, files, opts?)` — persist tarball if requested, parse manifest, validate module presence, rebuild the tenant's `TenantState` atomically, return a `RegisterResult`.
- [x] 3.6 Keep `recover()` over `workflows/` prefix unchanged in behavior — calls `registerTenant` for each tarball.
- [x] 3.7 Add `list(tenant)` accessor returning the tenant's workflow manifests (needed by dashboard / trigger UI).
- [x] 3.8 Implement `dispose()` as a no-op for this change (sandboxes are not owned here).
- [x] 3.9 Delete the busy/retiring test in `workflow-registry.test.ts` at line 370 ("re-upload while an invocation is in-flight defers dispose of the old sandbox until the invocation finishes"). The equivalent observable behavior is now covered by `sandbox-store.test.ts` (task 2.7).
- [x] 3.10 Update remaining tests in `workflow-registry.test.ts` to assert against `registry.lookup` / `registry.list` instead of `registry.runners`. Drop assertions on `runner.sandbox`, `runner.invokeHandler`, `runner.onEvent`.

## 4. Runtime package: rewrite `Executor`

- [x] 4.1 In `packages/runtime/src/executor/index.ts`, change `createExecutor({ bus })` → `createExecutor({ bus, sandboxStore })`.
- [x] 4.2 Change `Executor.invoke` signature from `invoke(runner, triggerName, payload)` to `invoke(tenant, workflow, triggerName, payload, bundleSource)`. (`bundleSource` is needed for on-demand sandbox construction; see task 4.6 for how it's passed.)
- [x] 4.3 Inside `invoke`, resolve the sandbox via `await sandboxStore.get(tenant, workflow, bundleSource)`.
- [x] 4.4 Change the `runQueue` key from `${workflow.tenant}/${workflow.name}` to `${tenant}/${workflow.sha}`.
- [x] 4.5 Call `sb.run("__trigger_" + triggerName, payload, { invocationId, tenant, workflow: workflow.name, workflowSha: workflow.sha })` directly; remove the `runner.invokeHandler` indirection.
- [x] 4.6 Wire `onEvent` for each sandbox once on first use (replace the `WeakSet<WorkflowRunner>` with a `WeakSet<Sandbox>` or keyed map).
- [x] 4.7 Delete `packages/runtime/src/executor/types.ts` if it only held `WorkflowRunner`; otherwise remove the `WorkflowRunner` interface and its exports.
- [x] 4.8 Update `packages/runtime/src/executor/index.test.ts` to the new signature. Construct a fake `SandboxStore` that returns a stub `Sandbox`. Preserve the per-workflow serialization, cross-workflow parallelism, failure-unblocks-queue, and HTTP-result-shape test cases.

## 5. Runtime package: adapt HTTP trigger middleware

- [x] 5.1 In `packages/runtime/src/triggers/http.ts`, change the registry dependency from `HttpTriggerRegistry` + `runner` lookup to `registry.lookup(tenant, method, path)`.
- [x] 5.2 Parse `tenant` from the webhook path (`/webhooks/<tenant>/<workflow>/<trigger-path>` per multi-tenant spec).
- [x] 5.3 On lookup miss, return 404. On lookup hit, validate body/query/params via the returned `validator`; on failure, return 422 `{ error, issues }`.
- [x] 5.4 Call `executor.invoke(tenant, workflow, triggerName, payload, bundleSource)` — source the `bundleSource` from the registry (add a `lookupBundle(tenant, workflowName)` accessor on the registry if the existing `lookup` result doesn't carry it).
- [x] 5.5 Preserve `GET /webhooks/` 204/503 behavior (204 if any tenant has triggers registered, 503 otherwise).
- [x] 5.6 Update `packages/runtime/src/triggers/http.test.ts` to construct a fake registry with the new lookup shape and a fake executor matching the new signature. All existing test cases (422 on validation failure, 404 on no match, successful invocation, security tests) remain valid.

## 6. Runtime package: bootstrap wiring

- [x] 6.1 In `packages/runtime/src/main.ts`, construct `sandboxFactory = createSandboxFactory({ logger })` and `sandboxStore = createSandboxStore({ sandboxFactory, logger })` between bus/consumer init and registry construction.
- [x] 6.2 Pass `sandboxStore` into the executor: `createExecutor({ bus, sandboxStore })`.
- [x] 6.3 Register a shutdown hook (via the existing service-lifecycle plumbing) that calls `sandboxStore.dispose()` followed by `sandboxFactory.dispose()` on stop.
- [x] 6.4 Registry construction no longer wires sandboxes — just metadata. Verify `registry.recover()` runs before the HTTP server binds.
- [x] 6.5 Update `packages/runtime/src/integration.test.ts` and `packages/runtime/src/cross-package.test.ts` only as needed for the new bootstrap wiring. End-to-end behavior SHALL remain unchanged; any test modifications SHALL be construction-level, not assertion-level.

## 7. Dashboard / trigger UI consumer updates

- [x] 7.1 In `packages/runtime/src/ui/trigger/`, replace `registry.runners` iteration with `registry.list(tenant)` (or a global `listAll()` depending on the current UI scope). Tests in the same directory adapt.
- [x] 7.2 In `packages/runtime/src/ui/dashboard/`, same treatment — swap `runners[]` consumption for the new metadata accessor. Verify the dashboard list view still renders the same columns.

## 8. Documentation sync

- [x] 8.1 Check `/SECURITY.md` §2 and §5 for references to `SandboxFactory` caching or `WorkflowRunner`. Update to describe the `SandboxStore` + metadata-registry split. No threat-model change expected.
- [x] 8.2 Update `openspec/project.md` if its Architecture section names `WorkflowRunner` or `SandboxFactory` caching as load-bearing. Reflect the new `SandboxStore` seam.
- [x] 8.3 Update `CLAUDE.md` if any code-conventions section references the runner abstraction. (No-op: CLAUDE.md has no runner references.)

## 9. Security tests

- [x] 9.1 Extend `sandbox-store.test.ts` with: "tenant A's sandbox cannot be accessed via tenant B's key" — `store.get("A", ...)` and `store.get("B", ...)` return distinct instances, and mutating one does not affect the other (top-level module state smoke test). (Covered by "different tenants with the same sha get distinct sandboxes".)
- [x] 9.2 Extend `sandbox-store.test.ts` with: "`__hostCallAction` rejects unknown action names and invalid inputs" — smoke test that the closure wired at sandbox construction enforces the manifest's action allowlist + schemas.
- [x] 9.3 Confirm no new global is added to the sandbox; the existing host-bridge inventory test in `packages/sandbox/src/host-call-action.test.ts` still passes unchanged.

## 10. Validation

- [x] 10.1 Run `pnpm validate` (lint + format check + type check + tests). All must pass. (419 tests passing; tofu fmt + validate green across local/upcloud/persistence.)
- [x] 10.2 Run `pnpm exec openspec validate sandbox-store --strict`. Resolve any spec/proposal/design issues. (Strict validate: `Change 'sandbox-store' is valid`.)
- [ ] 10.3 Run the runtime via `pnpm dev` or `pnpm start`, upload a workflow via `POST /api/workflows/<tenant>`, fire a webhook, confirm 200 response and archive entry written. Confirm re-uploading the same bundle (same sha) does not produce a second sandbox, and re-uploading with a changed bundle does.
