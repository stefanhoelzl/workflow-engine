## 1. Core + SDK

- [x] 1.1 Replace `schema` with `inputSchema` + `outputSchema` on `httpTriggerManifestSchema`; export `HttpTriggerManifest` + `TriggerManifest` types.
- [x] 1.2 `httpTrigger()` callable synthesises `inputSchema` (composite) + `outputSchema` (`HttpTriggerResult`) as own-properties.
- [x] 1.3 Vite plugin emits `inputSchema` + `outputSchema` in the manifest trigger entry.

## 2. Runtime descriptor types

- [x] 2.1 `BaseTriggerDescriptor<K>` with `kind`, `name`, `inputSchema`, `outputSchema`.
- [x] 2.2 `HttpTriggerDescriptor extends BaseTriggerDescriptor<"http">` with `type: "http"`, `path`, `method`, `params`, `body`, optional `query` — body/query are JSON Schemas (not validators).
- [x] 2.3 `InvokeResult<T>` envelope type exported from `executor/types.ts`.

## 3. Shared validator + TriggerSource interface

- [x] 3.1 `packages/runtime/src/triggers/validator.ts` — `validate(descriptor, rawInput)` with WeakMap-cached Ajv compiles.
- [x] 3.2 `packages/runtime/src/triggers/source.ts` — `TriggerSource<K>` interface + `TriggerViewEntry<K>` type.
- [x] 3.3 Unit tests for validator (success / failure / security / cache).

## 4. Executor envelope

- [x] 4.1 `executor.invoke(tenant, workflow, descriptor, input, bundleSource) → InvokeResult<unknown>` — kind-agnostic.
- [x] 4.2 Remove HTTP-specific result shaping and `ERROR_RESPONSE` sentinel from executor.
- [x] 4.3 Update executor unit tests to assert on `{ ok, output | error }` envelope.

## 5. HTTP source

- [x] 5.1 `createHttpTriggerSource({ executor })` → `{ kind, start, stop, reconfigure, middleware }`.
- [x] 5.2 Source owns its URL-pattern map (from `reconfigure(view)`); static-path-wins and `:param`/`*rest` semantics preserved.
- [x] 5.3 Middleware pipeline: URL parse → tenant regex → lookup → body parse → shared `validate()` → `executor.invoke` → serialise output | 500 on error sentinel.
- [x] 5.4 Tests cover contract (kind, start/stop/reconfigure), routing, dispatch (200/422/500/404), health probe, security.

## 6. WorkflowRegistry as plugin host

- [x] 6.1 Accept `sources: readonly TriggerSource[]` option; default `[]`.
- [x] 6.2 On `registerTenant` / `recover` success, partition descriptors by `descriptor.kind` and push `reconfigure(kindSlice)` synchronously to each source.
- [x] 6.3 Drop `lookup()` from `WorkflowRegistry` — HTTP routing now lives in HTTP source.
- [x] 6.4 Drop `PayloadValidator` machinery from the registry; shared `validate()` is the only path.
- [x] 6.5 Update `workflow-registry.test.ts` to use `list(tenant)` in place of `lookup()`.

## 7. main.ts wiring + UI

- [x] 7.1 `main.ts`: construct executor → construct HTTP source → await `source.start()` → pass `sources: [httpSource]` to registry → mount `httpSource.middleware`.
- [x] 7.2 Wire graceful shutdown: `await Promise.allSettled(triggerSources.map(s => s.stop()))`.
- [x] 7.3 Trigger UI middleware accepts `{ registry, executor }`; adds kind-agnostic `POST /trigger/<tenant>/<workflow>/<trigger-name>` handler.
- [x] 7.4 Trigger UI page: HTTP card renders form from `descriptor.body` + posts to webhook URL; non-HTTP (future) renders full `inputSchema` + posts to `/trigger/`. Kind icon in card summary.
- [x] 7.5 Client-side `trigger-forms.js`: post `jedison.getValue()` as-is (no more `.body` sub-field extraction).
- [x] 7.6 Dashboard invocation row renders kind icon; `fetchInvocationRows` resolves kind from registry at render time.

## 8. Tests + contract suite

- [x] 8.1 Shared `TriggerSource` contract test (`source.contract.test.ts`) parameterised by kind.
- [x] 8.2 Update `integration.test.ts` to use `registry.list("acme")` and the new executor signature.
- [x] 8.3 Update `sandbox-store.test.ts` manifest fixture (`inputSchema`/`outputSchema`).
- [x] 8.4 Update UI middleware tests (dashboard + trigger) for new registry interface.

## 9. Docs

- [x] 9.1 Add `generalize-triggers` upgrade note to `CLAUDE.md`.
- [x] 9.2 Refresh `openspec/project.md` architecture principles (TriggerSource, uniform trigger shape).

## 10. Validation

- [x] 10.1 `pnpm validate` passes — lint, typecheck, 449 tests, tofu fmt + validate.
- [ ] 10.2 `pnpm test:wpt` not run in this PR — WPT suite is an independent CI job; trigger-generalization does not touch WPT primitives.
- [ ] 10.3 Manual `pnpm local:up` smoke test deferred — requires OAuth2 secrets; integration test covers end-to-end dispatch via the new source path.
