## Why

A workflow with zero triggers uploads successfully today and registers silently with `descriptors: []` — taking a slot in the registry, surfacing in the dashboard, but unable to fire anything. The author gets no feedback that the workflow is dead.

More broadly, the schema in `packages/core/src/index.ts` already enforces several manifest rules (trigger-name regex, cron `schedule.min(1)`-with-sentinel-exception, IANA `tz` validation), but `packages/sdk/src/cli/build-workflows.ts` carries hand-written duplicates that produce friendlier messages and run earlier. This change establishes the schema as the **single canonical tier** for serializable manifest validation: it adds the missing rules, deletes the build-time duplicates, and introduces a shared `formatIssue` formatter so author-facing error text is rendered identically whether the failure is caught by the build's final-pass `safeParse` or by the server's `ManifestSchema.parse` on upload.

## What Changes

- **New rule.** Reject manifests where any workflow has zero triggers. Suffix: `must declare at least one trigger`.
- **New rule.** Reject manifests with duplicate trigger names within a workflow. (Today implicit via JS export-name uniqueness; net-new at the schema tier.)
- **New rule.** Reject manifests with duplicate action names within a workflow. (Same shape as above.)
- **Migrated rule.** HTTP trigger `response.headers` JSON Schema must not declare reserved headers — moved from build-time hand-written check to `httpTriggerManifestSchema` `.refine` walking `response.headers.properties`. Build-time check deleted.
- **De-duplicated rules.** Build-time duplicates of rules already enforced by the schema are deleted: trigger `name` regex, action `name` regex, cron `schedule` non-empty, cron `tz` non-empty. The schema is unchanged for these — only the build-time duplicates and their wording are removed; authors continue to see equivalent rejections via the new `safeParse` final pass.
- **New shared formatter.** `formatIssue(issue, parsedValue)` in `packages/core` renders a single Zod issue into a single-line `Workflow "<name>": <type> trigger "<name>": <suffix>` string by walking `issue.path` and peeking at `parsedValue.triggers[i].type/.name` (and same for `actions[i]`). Falls back to a path-string representation when the leaf isn't inside a known collection.
- **Build pipeline.** `buildManifestFromMod` runs `workflowManifestSchema.safeParse(built)` as a final pass; each Zod issue produces one `buildContext.error(formatIssue(issue, built))` call. Authors continue to see one-line errors per problem in the same format as today's live-SDK-object rules.
- **Server upload handler.** `packages/runtime/src/api/upload.ts` augments each entry of the existing `issues[]` array with a new `formatted: string` field rendered via the same `formatIssue`. The pre-existing `{ path, message }` shape is preserved as a non-breaking superset.
- **BREAKING for non-conforming manifests.** Any manifest with zero triggers in a workflow, duplicate trigger/action names within a workflow, or reserved-header declarations on an http `response.headers` schema is now rejected with HTTP 422. Pre-existing workflows already registered keep running; the rejection bites only on the next upload. Documented as an upgrade note.

## Capabilities

### New Capabilities

None. All deltas modify existing capabilities.

### Modified Capabilities

- `workflow-manifest`: ADDS three requirements (≥1 trigger per workflow; unique trigger names within a workflow; unique action names within a workflow) and ADDS a fourth (reserved http response headers rejected by the schema, currently build-time-only).
- `workflow-build`: MODIFIES the existing requirement that has the build plugin enforce trigger-name identifier regex (line 287 in `workflow-build/spec.md`) — that responsibility now flows through the new `safeParse`-final-pass requirement; deletes build-time hand-written checks for trigger-name regex, action-name regex, cron schedule/tz non-empty, and reserved http response headers; ADDS a requirement that the build SHALL run `workflowManifestSchema.safeParse` as a final pass and surface each Zod issue via `buildContext.error(formatIssue(...))`.
- `action-upload`: MODIFIES the requirement that defines the 422 `issues[]` shape — each entry gains an additional `formatted: string` field rendered via `formatIssue`. The pre-existing `{ path, message }` fields remain unchanged.

## Impact

- **Code touched.**
  - `packages/core/src/index.ts` — `formatIssue` export; new `.refine`s on `workflowManifestSchema` (≥1 trigger, unique trigger/action names) and on `httpTriggerManifestSchema` (reserved response headers).
  - `packages/sdk/src/cli/build-workflows.ts` — `safeParse` final pass; deletion of hand-written checks for trigger-name regex, action-name regex, cron schedule/tz non-empty, reserved http response headers.
  - `packages/runtime/src/api/upload.ts` — `formatted` field added to each issue in 422 responses.
- **Tests touched.** Existing tests asserting old build-time wording in `build-workflows.test.ts` are updated to expect the new `formatIssue`-rendered text. New tests in `packages/core` cover each new/migrated rule and the `formatIssue` path-walk behavior. `action-upload` tests gain a `formatted`-field assertion.
- **Wire format.** HTTP 422 issue shape becomes a non-breaking superset (`{ path, message, formatted }`). HTTP status codes unchanged.
- **Operator-visible.** Pre-existing workflows that violate one of the new/migrated rules continue running but fail on next upload. Operators may need to fix and re-upload affected workflows. Documented in `docs/upgrades.md` per project convention.
- **Dependencies.** None added.
- **Sandbox / EventBus / persistence.** Not affected — change is confined to the upload-validation boundary.
