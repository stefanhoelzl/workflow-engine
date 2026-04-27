## 1. Core (`@workflow-engine/core`)

- [x] 1.1 Replace `jsonSchemaValidator` in `packages/core/src/index.ts` with a `z.custom` predicate that calls `z.fromJSONSchema(value)` inside try/catch (returns `true` on success, `false` on throw).
- [x] 1.2 Delete the `Ajv2020.default()` instantiation and the `validateJsonSchema = ajv.getSchema('https://json-schema.org/draft/2020-12/schema')!` block from `packages/core/src/index.ts`.
- [x] 1.3 Delete the `import Ajv2020 from "ajv/dist/2020.js"` line from `packages/core/src/index.ts`.
- [x] 1.4 Drop `"ajv"` from `packages/core/package.json` `dependencies`.
- [x] 1.5 Update `packages/core/src/index.test.ts`: any test that expects Ajv-shaped errors out of `ManifestSchema` parsing now expects Zod's standard `ZodError` shape. The `ManifestSchema.parse(invalidSchema)` rejection path stays — only the issue inspection changes.
- [x] 1.6 Run `pnpm --filter @workflow-engine/core check` and `pnpm --filter @workflow-engine/core test` locally; both pass.

## 2. Main thread (`@workflow-engine/runtime` — host-side validators)

- [x] 2.1 Rewrite `packages/runtime/src/triggers/validator.ts`: drop `Ajv2020`, drop the `compile` + `compiledCache` WeakMap, drop `issuesFromValidator`. Keep the public `validate` and `validateOutput` signatures; their `descriptor` parameter now exposes pre-rehydrated Zod schemas (via a new field on the descriptor, see 2.3) and the body of each function becomes `descriptor.zodInputSchema.safeParse(input)` (or `zodOutputSchema.safeParse(output)`) plus a Zod-issue-to-`ValidationIssue[]` mapper.
- [x] 2.2 Add a small helper `zodIssuesToValidationIssues(issues: ZodIssue[]): ValidationIssue[]` in `triggers/validator.ts` (or hoisted to a shared module). Each issue maps `{path, message}` directly; `ZodIssue.path` already returns the segment array.
- [x] 2.3 Extend `packages/runtime/src/workflow-registry.ts` so `registerTenant` (or wherever `TriggerDescriptor` records are constructed) calls `z.fromJSONSchema(descriptor.inputSchema)` and `z.fromJSONSchema(descriptor.outputSchema)` once at registration time and attaches the resulting Zod schemas to the descriptor (or to a sibling registered-workflow record). On rehydration failure, the registration SHALL fail atomically with a tenant-visible error pointing at the offending trigger.
- [x] 2.4 Update `packages/runtime/src/triggers/build-fire.ts` (and the `validate` callback wired into it) so the trigger-input validation step reads the pre-rehydrated Zod schema from the descriptor rather than calling Ajv compile.
- [x] 2.5 Update `packages/runtime/src/workflow-registry.test.ts` to assert that pre-rehydrated validators exist on registered descriptors and that registration fails atomically when a structurally-invalid JSON Schema is provided.
- [x] 2.6 Run `pnpm --filter @workflow-engine/runtime check` and `pnpm --filter @workflow-engine/runtime test` locally; both pass.

## 3. Worker plugin (`host-call-action`)

- [x] 3.1 Reshape the `Config` interface in `packages/runtime/src/plugins/host-call-action.ts` from `{ inputValidatorSources: Record<string, string>; outputValidatorSources: Record<string, string> }` to `{ inputSchemas: Record<string, JSONSchema>; outputSchemas: Record<string, JSONSchema> }`. Update the `import type` re-exports accordingly.
- [x] 3.2 Delete `instantiateValidator` and the `new Function("module", "exports", source + "; return module.exports;")` path from `host-call-action.ts`. Replace `compileValidators` with a `rehydrateValidators` that iterates the schemas record and calls `z.fromJSONSchema(schema)` once per action.
- [x] 3.3 Update `worker(_ctx, _deps, config)`: rehydrate input + output Zod schemas at boot, store in two `Map<string, ZodSchema>`. `validateAction` and `validateActionOutput` now look up the Map, call `.safeParse(value)`, and on failure throw `ValidationError` with `errors: result.error.issues` (raw Zod issues) and `issues: zodIssuesToValidationIssues(result.error.issues)` (`{path, message}[]`).
- [x] 3.4 Shrink `packages/runtime/src/host-call-action-config.ts` to a JSON-Schema pass-through: drop `Ajv2020`, drop `standaloneCode`, drop the `for (const action of manifest.actions) { ajv.compile + standaloneCode }` loop. The function becomes a copy of action `input`/`output` JSON-Schema objects into the `inputSchemas` / `outputSchemas` records.
- [x] 3.5 Delete `packages/runtime/src/ajv-shared.ts`. Remove its imports from any remaining call site (now only the host-call-action plugin and triggers/validator, both of which no longer need `ajvPathToSegments` or `structuredCloneJson`). For the structured-clone helper, inline the trivial body into the trigger validator if still needed; otherwise drop.
- [x] 3.6 Drop `"ajv"` from `packages/runtime/package.json` `dependencies`.
- [x] 3.7 Update `packages/runtime/src/plugins/host-call-action.test.ts`: error-shape assertions move from Ajv-shape (`instancePath`, `keyword`, `schemaPath`, `params`) to Zod-shape (`code`, `expected?`, `received?`, `path`, `message`). The `issues` field assertions stay (still `{path, message}[]`).
- [x] 3.8 Run `pnpm --filter @workflow-engine/runtime check` and `pnpm --filter @workflow-engine/runtime test` locally; both pass.

## 4. Cross-cutting

- [x] 4.1 Grep `packages/`, `workflows/`, and `scripts/` for leftover references to `instancePath`, `schemaPath`, `keyword` (in the Ajv sense), `validator.errors` (Ajv-shape reads), `ajv-shared`, `Ajv2020`, `standaloneCode`. Fix or delete every hit.
- [x] 4.2 Update `SECURITY.md` per the renames listed in the design's Item 3 catalogue: lines 69, 198, 387, 479-484, 496, 502, 663, 767, 788, 804, 852, 863. Add the new bullet on validator-source eval removal as defence in depth.
- [x] 4.3 Add a CLAUDE.md `## Upgrade notes` entry: validator engine swap from Ajv to Zod via `z.fromJSONSchema()`. Manifest wire format unchanged. `ValidationError.issues` shape unchanged. `ValidationError.errors` shape changes from Ajv error objects to `ZodIssue[]`. No tenant rebuild required for behaviour preservation.
- [x] 4.4 Run `pnpm validate` (lint + check + test + tofu fmt/validate). All green.

## 5. Verification

- [x] 5.1 Boot `pnpm dev --random-port --kill`; confirm stdout contains `Dev ready on http://localhost:<port> (owner=dev)`.
- [x] 5.2 `GET /api/workflows/dev` (headers: `X-Auth-Provider: local`, `Authorization: User dev`) → 200 lists `demo`.
- [x] 5.3 `POST /webhooks/dev/demo/greet` with body `{"name":"alice"}` → 202; `.persistence/` event stream shows paired `invocation.started` / `invocation.completed`. Inspect the events to confirm no `error.issues` regression.
- [x] 5.4 `POST /webhooks/dev/demo/greet` with body `{"foo":"bar"}` (missing required `name`) → 422; response body contains `issues: [{path: ["name"], message: <human-readable>}]`. Confirms host-side trigger Zod validator produces the same wire shape as before.
- [x] 5.5 Manual fire `fail` trigger → confirm `action.error` event for the `boom` action carries an Ajv-free error shape: `error.issues` is `{path, message}[]` and `error.errors` (if present in the persisted event payload) is the Zod-issue shape.
- [x] 5.6 `GET /dashboard` (session cookie for `dev`) → 200; HTML contains `kind-trigger` and `kind-action` spans. Confirms the dashboard renderer survived the issue-shape change.
- [x] 5.7 Verify no `ajv` in the resolved dep graph: `pnpm why ajv` returns no production matches under `packages/`.
