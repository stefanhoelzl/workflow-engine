## 1. Core manifest schema

- [x] 1.1 In `packages/core/src/index.ts`, add `manualTriggerManifestSchema` as a Zod object with `type: z.literal("manual")`, `name` (URL-safe regex), `inputSchema`, `outputSchema`. (Extras are stripped by Zod's default object mode — same behaviour as cron/http; no strict mode.)
- [x] 1.2 Add `manualTriggerManifestSchema` to the `triggerManifestSchema` discriminated union alongside `httpTriggerManifestSchema` and `cronTriggerManifestSchema`.
- [x] 1.3 Export `ManualTriggerManifest` type (`z.infer<typeof manualTriggerManifestSchema>`).
- [x] 1.4 Add unit tests covering: manual entry accepted with required fields; http-only extras stripped; cron-only extras stripped; rejected when `inputSchema` or `outputSchema` missing; rejected with non-URL-safe name.

## 2. SDK factory and brand

- [x] 2.1 In `packages/sdk/src/index.ts`, add `MANUAL_TRIGGER_BRAND = Symbol.for("@workflow-engine/manual-trigger")`.
- [x] 2.2 Add `ManualTrigger` type (branded callable with `inputSchema`, `outputSchema` readonly properties).
- [x] 2.3 Implement `manualTrigger({ input?, output?, handler })` factory: callable that runs `handler(input)`, attaches brand, defines `inputSchema = input ?? z.object({})`, `outputSchema = output ?? z.unknown()`, and does not expose `handler` as an own property.
- [x] 2.4 Implement `isManualTrigger(value)` type guard.
- [x] 2.5 Export `manualTrigger`, `MANUAL_TRIGGER_BRAND`, `ManualTrigger`, `isManualTrigger` from the SDK root.
- [x] 2.6 Extend the `Trigger` umbrella type to `HttpTrigger | CronTrigger | ManualTrigger`.
- [x] 2.7 Add SDK unit tests: factory returns branded callable; defaults applied; author-provided schemas preserved; `isManualTrigger` returns `true` on manual triggers and `false` on http/cron/non-trigger values.

## 3. Vite plugin discovery

- [x] 3.1 In `packages/sdk/src/plugin/index.ts`, import `isManualTrigger` and `ManualTrigger`.
- [x] 3.2 Extend `DiscoveredExports` with `manualTriggerEntries: [string, ManualTrigger][]` and add `ManifestManualTriggerEntry` to the `ManifestTriggerEntry` union.
- [x] 3.3 Add a branch in `discoverExports` that routes `isManualTrigger(value)` matches into `manualTriggerEntries`.
- [x] 3.4 Implement `buildManualTriggerEntry(exportName, trigger, workflowName, ctx)` that validates the export-name regex (`TRIGGER_NAME_RE`) and produces `ManifestManualTriggerEntry` objects with JSON-schema-converted `inputSchema` and `outputSchema`.
- [x] 3.5 Wire the manual entries into the manifest emission path alongside cron and http entries.
- [x] 3.6 Add plugin unit tests: default schemas converted correctly; author-provided schemas preserved; invalid identifier fails the build; manifest contains only the allowed fields.

## 4. Runtime executor and registry wiring

- [x] 4.1 In `packages/runtime/src/executor/types.ts`, add `ManualTriggerDescriptor extends BaseTriggerDescriptor<"manual">`. Extend the `TriggerDescriptor` union.
- [x] 4.2 In `packages/runtime/src/workflow-registry.ts`, add a descriptor builder branch (`buildManualDescriptor`) and extend `buildDescriptors` to handle `entry.type === "manual"`.
- [x] 4.3 Ensure `reconfigureBackends` partitions manual entries to the manual backend (already kind-generic — verified by existing partitioning loop in workflow-registry).
- [x] 4.4 Registry entries include manual triggers with correct descriptor shape — covered by the Group-7 integration test which exercises upload → `registry.getEntry("acme", "manual-demo", "rerun")` → `fire({})` → `executor.invoke` with `descriptor.kind === "manual"`.

## 5. Manual TriggerSource backend

- [x] 5.1 Create `packages/runtime/src/triggers/manual.ts` exporting `createManualTriggerSource(): ManualTriggerSource`.
- [x] 5.2 Implement `kind: "manual"`, `start()` and `stop()` as resolved no-ops.
- [x] 5.3 Implement `reconfigure(tenant, entries)` returning `{ ok: true }` with no side effects.
- [x] 5.4 Register the manual source alongside HTTP and cron sources in `packages/runtime/src/main.ts`.
- [x] 5.5 Unit tests (`manual.test.ts`) + extend `source.contract.test.ts` with a `manualKind` factory so the shared lifecycle invariants run against the manual source.

## 6. Trigger UI rendering

- [x] 6.1 In `packages/runtime/src/ui/triggers.ts`, add `manual: "\u{1F464}"` to `KIND_ICONS` and `manual: "Manual"` to `KIND_LABELS`.
- [x] 6.2 In the same file, add an explicit `descriptor.kind === "cron"` branch in `triggerCardMeta` (converting the `else-is-cron` tail) and a new `manual` case returning `""`.
- [x] 6.3 In `packages/runtime/src/ui/trigger/page.ts`, add an explicit `descriptor.kind === "cron"` branch and a new `manual` branch in `descriptorToCardData`; the manual branch returns `meta: ""` + `submitUrl: /trigger/<t>/<w>/<name>`.
- [x] 6.4 Rely on the existing `schemaHasNoInputs` helper for form suppression — no new code needed; confirmed via rendering test that a default-input manual trigger produces a card with no `.form-container` and a bare Submit button.
- [x] 6.5 Added UI tests covering manual card rendering with the person icon, form-suppression on empty input schema, form rendering for author-provided input schemas, and successful dispatch via `/trigger/<t>/<w>/<name>` returning the handler's output.

## 7. Integration and negative-path tests

- [x] 7.1 Added `manual trigger integration` block in `packages/runtime/src/integration.test.ts` covering registry.getEntry → fire → executor.invoke with correct tenant/workflow/descriptor/payload stamping.
- [x] 7.2 Added regression: HTTP source's `getEntry` returns undefined for a manual trigger after upload, proving manual entries are never addressable via `/webhooks/*`.
- [x] 7.3 The existing `/trigger` POST path uses `requireTenantMember`; unauthenticated requests are rejected by the session middleware chain before reaching the kind-agnostic handler. Covered kind-agnostically by existing trigger-ui middleware tests — no manual-specific regression needed beyond 7.4.
- [x] 7.4 Added a non-member session test in `middleware.test.ts` that asserts `POST /trigger/t0/ops/rerun` returns 404 when the session user is not a member of `t0`, and `fire` is never invoked.
- [x] 7.5 Concurrency is kind-agnostic (the runQueue serialises on `(tenant, workflow.sha)` regardless of trigger kind). Covered by existing executor/runQueue tests; no manual-specific test adds signal.

## 8. Validation and docs

- [x] 8.1 `pnpm validate` (lint + typecheck + tests + tofu validation) — all 793 tests pass.
- [x] 8.2 Added `add-manual-trigger` entry to `CLAUDE.md` upgrade notes.
- [x] 8.3 `pnpm exec openspec validate add-manual-trigger --strict` — valid.
