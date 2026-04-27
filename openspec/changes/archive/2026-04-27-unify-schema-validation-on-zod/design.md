## Context

Today the validator pipeline is split between two engines that share no semantics:

- Authors write Zod schemas in workflow source (`httpTrigger.body`, `manualTrigger.input/output`, `action.input/output`).
- The SDK build runs `.toJSONSchema()` on each Zod schema and bakes plain JSON Schema into `manifest.json`. Zod features that have no JSON-Schema representation (`.transform()`, `.refine()`, `.coerce()`, fn-valued `.default()`, branded types) are silently dropped.
- The runtime validates payloads with Ajv against the lossy JSON-Schema projection, not the original Zod schema. The author's contract and the runtime's contract diverge.

`workflows/src/demo.ts` does not yet exercise any of the divergent features, but the divergence is a latent footgun: an author who uses `z.string().transform(s => s.trim())` on `httpTrigger.body` would find the transform silently dropped at the wire boundary, the bug surfacing only as "my handler received an untrimmed string" with no compile-time signal.

Three runtime sites compile Ajv validators today:

1. **Trigger validator** (main thread, `packages/runtime/src/triggers/validator.ts`) — Ajv-compiled per-schema with a WeakMap cache.
2. **Action validator** (worker plugin, `packages/runtime/src/plugins/host-call-action.ts`) — Ajv `standaloneCode` emits dependency-free JS source per action; the plugin's `worker()` instantiates each via `new Function(source)` at sandbox boot.
3. **Manifest meta-schema** (core, `packages/core/src/index.ts`) — Ajv's draft-2020-12 meta-schema validates that uploaded `inputSchema`/`outputSchema`/`body`/`input`/`output` fields are structurally valid JSON Schema.

The plugin runs in a Node `worker_thread` (per `packages/sandbox/src/worker.ts:1` — `parentPort` from `node:worker_threads`), not inside the QuickJS guest VM. Plugin code can import any npm package, including Zod. The "Ajv runtime not bundled into the sandbox" framing in old comments referred to the QuickJS layer, not the worker thread.

Zod 4.3.0 added `z.fromJSONSchema()` (PR #5534, marked experimental). It accepts JSON Schema drafts 4, 7, 2020-12 and OpenAPI 3.0. Zod's docs disclaim 1:1 round-trip soundness — `fromJSONSchema(toJSONSchema(s)) ≠ s` in general, because Zod features without JSON-Schema representation are dropped on the way out. For our pipeline, that disclaimer is irrelevant: the SDK's `.toJSONSchema()` already drops those features at build time, so what reaches the manifest is already inside the round-trip-sound subset.

## Goals / Non-Goals

**Goals:**

- One schema engine end-to-end: authors write Zod, runtime enforces Zod (within the declarative subset).
- Eliminate `ajv` from the monorepo dependency graph.
- Eliminate the `host-call-action` plugin's `new Function(standaloneSource)` validator-instantiation path. (Defence in depth — the worker thread is trusted code, so this is not load-bearing, but it removes one `new Function` site.)
- Pre-rehydrate validators at construction time (workflow registration / sandbox boot) and attach to the natural data structures. Per-request rehydration is forbidden.
- Spec text becomes engine-agnostic where possible. Today's specs name "Ajv" because that was the implementation; the new specs describe behaviour, not the engine.

**Non-Goals:**

- **No build-time lint** against unsupported Zod features on trigger/action surfaces. The codebase has zero hits today (`workflows/src/demo.ts` and infrastructure schemas use only the declarative subset). Authors who reach for `.transform()` etc. on a trigger boundary accept that the transform won't run on the wire.
- **No manifest wire format change.** Trigger and action schemas remain JSON Schema in `manifest.json`. Tenants do not need to rebuild for behaviour preservation.
- **No move of action validation to the main thread.** Action validation continues to run in the Node worker thread (where the `host-call-action` plugin runs). Avoids an extra bridge round-trip per action call.
- **No tenant-facing API change** beyond the `ValidationError.errors` raw-issue shape, which was never documented as part of the SDK contract.
- **No additional cache abstraction.** Validators live as fields on the workflow descriptor / plugin Map, not in a separate cache layer with eviction policy.

## Decisions

### Decision 1: Wire format stays JSON Schema in `manifest.json`

The manifest is JSON-serialized into a tarball at upload time. Zod schemas are JS objects with closures; they don't survive serialization. JSON Schema is the only viable wire format unless we adopt a third-party Zod serializer (Zodex) — which was researched and rejected.

**Alternatives considered:**

- **Zodex JSON** (third-party Zod serializer with broader fidelity for declarative features). Rejected: smaller community, less battle-tested, doesn't transport the closure-bearing features either, adds a dep.
- **Ship live Zod values into the runtime via the workflow JS bundle** (which is already evaluated inside the sandbox, so Zod schemas are live there). Rejected: the host process would have to either (a) evaluate tenant JS in its own process to read schemas (defeats the QuickJS sandbox) or (b) RPC into the worker for every validation, adding bridge round-trips on the trigger ingress hot path.
- **A custom JSON Schema + Zod-extension sidecar** for features JSON Schema can't express. Rejected: more work to maintain than the value warrants, given today's authoring surface uses only the JSON-Schema-soundly-round-trippable subset.

### Decision 2: `z.fromJSONSchema()` rehydration at three sites

Replace each Ajv compile site with a Zod rehydration call:

| Site | Old | New |
|---|---|---|
| Trigger validator (main thread) | Ajv compile + WeakMap cache, called per-request from `triggers/validator.ts` | `z.fromJSONSchema()` at `WorkflowRegistry` registration; pre-rehydrated schemas attached to the registered-workflow record; `triggers/validator.ts` reads them and calls `.safeParse()` |
| Action validator (Node worker plugin) | Ajv `standaloneCode` strings in plugin `Config`, `new Function(source)` at `worker()` boot | JSON-Schema objects in plugin `Config`; `z.fromJSONSchema()` at `worker()` boot, schemas held in a `Map<actionName, {input, output}>` |
| Manifest meta-schema (core) | Ajv `getSchema('https://json-schema.org/draft/2020-12/schema')` invoked from a `z.custom` predicate | `z.custom((v) => { try { z.fromJSONSchema(v); return true } catch { return false } })` |

**Alternatives considered:**

- **Reconstruct Ajv per-call** rather than pre-rehydrating. Rejected: per-request validator construction was already forbidden in spirit (the old WeakMap cache existed to amortise compile cost). Pre-rehydration generalises the same idea cleanly.
- **Single shared cache layer** keyed on schema-object identity. Rejected: under Strategy 2 (pre-rehydrate at construction, attach inline), there's no sharing across workflows worth deduplicating. Bench shows `z.fromJSONSchema` runs in ~0.1 ms per schema; deduplicating across two-or-three identical schemas saves <1 ms total at workflow load. Cache abstraction is permitted by spec but not required.

### Decision 3: Pre-rehydration at construction; per-request construction forbidden

- `WorkflowRegistry.registerTenant()` rehydrates each trigger descriptor's `inputSchema` and `outputSchema` once at registration time, attaching the resulting Zod schemas to the descriptor (or to a sibling `RegisteredWorkflow` record). `buildFire` and `triggers/validator.ts` look up the pre-rehydrated schemas from the descriptor and call `.safeParse()`.
- `host-call-action`'s `worker()` rehydrates each action's input/output schema at sandbox boot and stores them in a Map. Per-call hot path is just `Map.get` + `.safeParse()`.
- Reused for the lifetime of the workflow (until unregistration) or sandbox (until eviction).
- Cache abstractions are NOT forbidden but NOT required; spec text says "per-request validator construction is forbidden", which permits implementers to add memoisation if a real reason emerges.

**Why this matters beyond perf:**

1. **Predictable failure surface.** A bad schema fails at workflow registration (a noisy boot-time error visible to the tenant) rather than first-request (a silent 500 to the first unlucky caller).
2. **Predictable startup tax.** Validation cost is paid at a single measurable point, not smeared across the request hot path.
3. **Cleaner data model.** "The workflow is its descriptors plus its rehydrated validators" is the natural shape; validators are properties of the workflow.

### Decision 4: `host-call-action` plugin `Config` reshape

```ts
// before
interface Config {
  readonly inputValidatorSources: Readonly<Record<string, string>>;   // Ajv standaloneCode JS source
  readonly outputValidatorSources: Readonly<Record<string, string>>;
}

// after
interface Config {
  readonly inputSchemas: Readonly<Record<string, JSONSchema>>;
  readonly outputSchemas: Readonly<Record<string, JSONSchema>>;
}
```

Both shapes are JSON-serialisable and survive the main-thread → worker-thread `postMessage` boundary that `assertSerializableConfig` enforces. The new shape is strictly simpler.

`host-call-action-config.ts` shrinks accordingly — no Ajv compilation, no `standaloneCode` string emission. It becomes a pass-through that copies action `input`/`output` JSON-Schema objects into the plugin config.

### Decision 5: `ValidationError.errors` field shape

The documented `ValidationError.issues: {path, message}[]` contract is unchanged. The undocumented `ValidationError.errors` sibling — historically the raw Ajv error array — changes to `ZodIssue[]` (`{code, expected?, received?, path, message}`).

**Alternatives considered:**

- **Drop `.errors` entirely; keep only `.issues`.** Rejected per Item 1 of the design interview: callers in tests and (potentially) tenant code may read `.errors` even if undocumented; preserving the field name keeps the surface stable.
- **Synthesise an Ajv-shape `.errors` from Zod issues.** Rejected: translation glue we'd maintain forever for a field whose only purpose would be bug-compatibility with code that depends on Ajv-specific fields.

### Decision 6: Engine-agnostic spec phrasing

Specs that previously named "Ajv" rephrase to engine-agnostic ("schema validator", "validator function") where possible. Engine identity (Zod, `z.fromJSONSchema`) lives in implementation comments only. This avoids re-baking the next migration's engine into the contract.

Three categories of spec delta land in this change:

- **Cleanup deltas** (relax over-specified Ajv-named clauses to engine-agnostic wording): `actions`, `sdk`, `sandbox`.
- **Architecture deltas** (capture the new pre-rehydration locus): `payload-validation`, `workflow-registry`.
- **Mechanical deltas** (drop dep from list): `core-package`.

### Decision 7: Zod version pin stays at `^4.0.0`; no version-pin tightening

`z.fromJSONSchema` is officially experimental, but lockfile + tests are sufficient as a regression tripwire. Tightening to `~4.3.x` would require a maintenance commitment to bump the manifest pin on every minor release we adopt, and the lockfile already prevents silent in-place changes between `pnpm install` runs.

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| `z.fromJSONSchema` is experimental; behaviour may shift on a Zod minor bump. | Lockfile pins exact resolved version. Test suite (`triggers/validator.test.ts`, `host-call-action.test.ts`) exercises the rehydration path against representative schemas; minor-bump behaviour drift fails CI before reaching main. Operator manually reviews Zod release notes when running `pnpm update zod`. |
| Per-call validation is 3-9× slower than Ajv `standaloneCode`. | Absolute cost is sub-microsecond (35-350 ns/call for typical schemas, per the design-phase benchmark). Bridge round-trip and event-emit overhead dominate. Workflows that demonstrably hot-loop on action calls have a held-in-reserve optimisation: skip `.safeParse()` when the rehydrated schema is `z.any()`/`z.unknown()` (the new default for omitted schemas). Not adopted in this change. |
| `z.fromJSONSchema` mapping for our `.toJSONSchema()` output may diverge from Ajv's behaviour on edge cases (e.g., `additionalProperties` interaction with `patternProperties`, OpenAPI-style `$ref` paths). | Our `.toJSONSchema()` output uses only the JSON-Schema-soundly-round-trippable subset. Identified divergences (per the design-phase research) — `anyOf+oneOf` together, `patternProperties+additionalProperties` together, OpenAPI `$ref` form — do not appear in any schema the SDK currently emits. Any future SDK feature that emits one of these constructs MUST audit `z.fromJSONSchema` parity in its proposal. |
| Out-of-tree consumers reading Ajv-specific fields (`keyword`, `instancePath`, `schemaPath`, `params`) on `ValidationError.errors` would break. | None known in-tree (verified by grep). Documented in the CLAUDE.md `## Upgrade notes` block as a possible breaking change for tenant code that catches `ValidationError`. Tenants using `.issues` are unaffected. |
| Manifest meta-schema check via `z.fromJSONSchema`-trial-and-catch may accept malformed JSON Schema that Ajv would reject (or vice versa). | Acceptable: the meta-schema check is a coarse "is this thing structurally a JSON Schema" gate at upload time. Edge-case malformed schemas that pass this gate fail later at rehydration time (workflow registration / sandbox boot), surfacing as a tenant-visible registration error. The error-locality regression is bounded. |
| Removing `new Function(standaloneSource)` is documented as a security improvement, but it isn't load-bearing (the worker is trusted code). Could read as overselling. | Frame as "defence in depth" in proposal and SECURITY.md, not as a load-bearing guarantee. The headline of the proposal is unified semantics, not eval removal. |

## Migration Plan

Atomic. One PR. `tasks.md` organises by layer (core, main thread, worker plugin, cross-cutting) so reviewers can read the diff in dependency order. Within-PR bisect is harder than between three smaller PRs, but the per-PR diff is small enough that bisect inside one PR is tractable.

The "mixed error-shape window" risk that motivated considering a staged migration dissolved on closer inspection: only the action-validator stage (worker plugin) has user-visible wire-shape effects via `ValidationError.errors`, and that swap is one file's diff.

Rollback strategy: revert the merge. The change is bounded to the validator pipeline; no schema migrations, no manifest format change, no infra change. A revert restores the old Ajv-based behaviour with no cleanup required.

## Open Questions

None. All seven design-interview items, three follow-up threads, and the bench-validation step were resolved before reaching this proposal. If `z.fromJSONSchema`'s mapping for a specific schema in the wild misbehaves, the fix is local (adjust the schema or the rehydration call site) and does not require revisiting this design.
