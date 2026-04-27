## Why

Workflow authors write schemas in Zod, but the runtime validates against an Ajv-compiled JSON Schema projection of those schemas. The two engines have different semantics: Zod features that have no JSON-Schema equivalent (`.transform()`, `.refine()`, `.coerce()`, fn-valued `.default()`, branded types, custom error formatters) are silently dropped or weakened by `.toJSONSchema()`. Today's `workflows/src/demo.ts` does not yet exercise any of those features, but the divergence is a latent footgun: an author who reaches for `z.string().transform(s => s.trim())` on `httpTrigger.body` would find the transform silently dropped at the wire boundary, and the bug would surface only as "my handler received an untrimmed string" — a runtime mystery with no compile-time signal.

This change unifies the validator engine on Zod end-to-end so that the schema the author writes is the schema the runtime enforces (within the declarative subset that round-trips through JSON Schema).

## What Changes

- Replace Ajv-compiled validators with Zod schemas rehydrated via `z.fromJSONSchema()` at every validation site: trigger input/output (main thread), action input/output (worker plugin), and manifest meta-schema (core).
- Remove the `host-call-action` plugin's `standaloneCode` + `new Function(source)` validator-instantiation path. Validators are now declarative Zod values; no JS source is generated, transferred, or eval'd at runtime. (Defence in depth — the worker thread is trusted code, so this is not load-bearing, but eliminating one `new Function` site is unambiguously good.)
- **BREAKING (in-tree only)** Reshape `host-call-action` plugin `Config`: `inputValidatorSources: Record<string, string>` and `outputValidatorSources: Record<string, string>` become `inputSchemas: Record<string, JSONSchema>` and `outputSchemas: Record<string, JSONSchema>`. The plugin's `worker()` rehydrates with `z.fromJSONSchema()` once at sandbox boot.
- **BREAKING (in-tree only)** `ValidationError.errors` field shape changes from Ajv error objects (`{keyword, instancePath, schemaPath, params, message}`) to `ZodIssue[]` (`{code, expected?, received?, path, message}`). The documented `ValidationError.issues` (`{path, message}[]`) is unchanged.
- Pre-rehydrate trigger schemas at `WorkflowRegistry` registration time and attach them to the registered-workflow record. Pre-rehydrate action schemas at `host-call-action` plugin boot. The same validator instance serves every invocation until the workflow is unregistered or the sandbox is evicted; per-request validator construction is forbidden. Cache abstractions are permitted but not required.
- Drop `ajv` from `packages/runtime/package.json` and `packages/core/package.json`. Delete `packages/runtime/src/ajv-shared.ts`. Shrink `packages/runtime/src/host-call-action-config.ts` to a JSON-Schema pass-through (no Ajv compilation).
- Manifest wire format unchanged: trigger and action schemas remain JSON Schema in `manifest.json`. No tenant rebuild required for behaviour preservation; tenants who rebuild get the new validator engine on the next `wfe upload`.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `actions`: `host-call-action` plugin's `Config` shape changes from validator-source strings to JSON-Schema objects; the plugin's worker rehydrates Zod schemas at boot. The clause that names `new Function(...)`-instantiation of Ajv `standaloneCode` is replaced with declarative-rehydration phrasing. `ValidationError.errors` field shape changes (issue raw shape; `issues` field is unchanged).
- `payload-validation`: Both action-output validation (sdk-support → `validateActionOutput`) and trigger-output validation (registry's `buildFire`) are rephrased engine-agnostically. The WeakMap-keyed-on-schema-object cache rule is replaced with "the validator is attached to the registered workflow at load time and reused for every invocation until unregistration; per-request construction is forbidden".
- `core-package`: Drop `ajv` from the package's runtime dependency list. `ManifestSchema`'s JSON-Schema field validator switches from an Ajv meta-schema check to a `z.fromJSONSchema`-trial-and-catch.
- `sdk`: Engine-agnostic phrasing — references to "Ajv validators" become "schema validators". The scenario "GIVEN an action whose input fails Ajv validation" becomes "GIVEN an action whose input fails schema validation".
- `sandbox`: The diagram comment `(Ajv validators from manifest)` becomes `(schema validators rehydrated from manifest)`.
- `workflow-registry`: The validator-construction step is rephrased to capture pre-rehydration at registration time; the parenthetical `(Ajv)` is removed. The registered-workflow record gains pre-rehydrated validator fields.

## Impact

- **Code:** `packages/runtime/src/triggers/validator.ts`, `packages/runtime/src/workflow-registry.ts`, `packages/runtime/src/host-call-action-config.ts`, `packages/runtime/src/plugins/host-call-action.ts`, `packages/core/src/index.ts`. Delete: `packages/runtime/src/ajv-shared.ts`. Test updates in the corresponding `*.test.ts` files.
- **Dependencies:** `ajv` removed from `packages/runtime/package.json` and `packages/core/package.json`. Net dep count drops by one across the monorepo.
- **Wire format:** Manifest JSON unchanged. Trigger 422 response shape (`{issues: [{path, message}]}`) unchanged. `action.error` / `trigger.error` event payload `error.issues` shape unchanged. Out-of-tree consumers that read Ajv-specific fields (`keyword`, `instancePath`, `schemaPath`, `params`) on the `ValidationError.errors` array — none known — would need to migrate.
- **SECURITY.md:** Pure renames at L69, L198, L387, L479-484, L496, L502, L663, L767, L788, L804, L852, L863. One new bullet on validator-source eval removal as defence in depth.
- **Performance:** Per-call validation is 3-9× slower than Ajv `standaloneCode` in absolute terms (35-350 ns/call → 117-350 ns/call for typical schemas), but sub-microsecond in absolute terms and dominated by bridge round-trip cost. Rehydration cost at workflow load / sandbox boot drops ~50× (~5 ms → ~0.1 ms per schema). Net win on boot, negligible cost on hot path.
- **CLAUDE.md `## Upgrade notes`:** New entry covering the validator engine swap and `ValidationError.errors` shape change. No tenant rebuild required.
- **Operational:** Pin Zod stays at `^4.0.0` in `core` and `sdk` package.json; lockfile + tests are the regression tripwire for `z.fromJSONSchema`'s experimental status.
