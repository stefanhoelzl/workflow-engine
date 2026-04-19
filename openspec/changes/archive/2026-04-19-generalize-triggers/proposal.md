## Why

Today the trigger pipeline is HTTP-shaped at every layer: the manifest's trigger entry carries a single HTTP-specific `schema` field; `WorkflowRegistry.lookup()` does URL-pattern matching for HTTP only; `executor.invoke` returns `HttpTriggerResult`; the trigger UI card posts to the webhook URL. Adding a second trigger kind (cron, mail, …) would require parallel copies of most of that code. This refactor generalises the architecture so a new kind lands as one self-contained source module — without shipping a new kind in this PR.

## What Changes

- **Unify the trigger model as `{ inputSchema, outputSchema, handler: async (input) => output }`.** Each kind's native protocol data is mapped into/out of this shape by its source.
- **Introduce `TriggerSource<K>`** — one per kind — with `{ kind, start(), stop(), reconfigure(view) }`. The HTTP source owns `/webhooks/*` routing + response shaping. Future cron/mail sources own their own loops.
- **Make `WorkflowRegistry` the plugin host.** Registry accepts `sources[]` at construction and pushes `reconfigure(kindView)` synchronously on every tenant change. `registry.lookup()` is removed; HTTP routing moves into the HTTP source.
- **Retype `executor.invoke` as** `(tenant, workflow, descriptor, input, bundleSource) => Promise<{ ok: true; output } | { ok: false; error }>`. Kind-agnostic. HTTP-specific response shaping moves into the HTTP source.
- **BREAKING — manifest schema**: each trigger entry gains `inputSchema` + `outputSchema` (JSON Schema) in place of the old `schema` field. SDK `httpTrigger()` synthesises both internally — workflow-author API unchanged.
- **Collapse validation**: one shared `validate(descriptor, rawInput)` against `descriptor.inputSchema` replaces per-component `runValidators`. Sources assemble raw native events; the validator returns validated input or issues.
- **Generalise the manual-fire UI**: trigger page renders a kind icon; HTTP cards post to the webhook URL with a body-only form (the HTTP source fills headers/url/method/params/query). Non-HTTP kinds post to a new kind-agnostic `POST /trigger/<tenant>/<workflow>/<trigger-name>` endpoint.
- **Dashboard kind icon**: invocation rows display a per-kind icon resolved from the registry at render time.
- **Per-kind packaging**: one file per kind in `packages/runtime/src/triggers/<kind>.ts`. Shared `source.ts` interface + `validator.ts` helper.
- **SDK author surface unchanged**: `httpTrigger({ path, method, body, query, handler })` stays identical.

## Capabilities

### Modified Capabilities

- `triggers`: the abstract umbrella becomes schema-driven (`inputSchema`/`outputSchema`); `TriggerDescriptor<K>` gains a `kind` discriminator; `TriggerSource` interface + plugin-host contract added.
- `http-trigger`: reframed as a `TriggerSource` implementation owning URL routing and HTTP response shaping. Composite input is `{ body, headers, url, method, params, query }`; output stays `HttpTriggerResult`.
- `executor`: `invoke` signature becomes `(tenant, workflow, descriptor, input, bundleSource) => Promise<InvokeResult<unknown>>`; kind-agnostic; error handling returns a typed sentinel.
- `payload-validation`: replaced with a shared `validate(descriptor, rawInput)` against `descriptor.inputSchema`. Sources decide protocol-level responses on failure.
- `trigger-ui`: kind-agnostic rendering with per-kind icons; new kind-agnostic POST endpoint for non-HTTP kinds.
- `sdk`: `httpTrigger(config)` synthesises `inputSchema` + `outputSchema` on the returned callable. Public author API unchanged.
- `workflow-manifest`: trigger entries now require `inputSchema` + `outputSchema`. **BREAKING** for on-disk tarballs.
- `workflow-registry`: accepts `sources[]`; drops `lookup()`; calls `reconfigure(kindFilteredView)` on every state change.

## Impact

- **Code**: `packages/core/src/index.ts` (manifest schema); `packages/sdk/src/index.ts` + `src/plugin/index.ts` (synthesise + emit schemas); `packages/runtime/src/triggers/*` (new `TriggerSource` interface, shared validator, HTTP source refactor); `packages/runtime/src/executor/*` (signature + envelope); `packages/runtime/src/workflow-registry.ts` (plugin host); `packages/runtime/src/main.ts` (wire sources); `packages/runtime/src/ui/trigger/*` + `ui/dashboard/*` (kind-agnostic rendering + icons).
- **On-disk/storage**: `workflows/<tenant>.tar.gz` manifest shape changes (wipe prefix on upgrade). `pending/` + `archive/` unchanged.
- **Public API**: `/webhooks/<tenant>/<workflow>/<trigger-path>` unchanged. New kind-agnostic `POST /trigger/<tenant>/<workflow>/<trigger-name>` endpoint for future kinds.
- **Tests**: shared `TriggerSource` contract tests; per-kind unit tests; validator unit tests; UI + dashboard tests updated.
