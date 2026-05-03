## 1. Core: formatIssue + schema rules

- [x] 1.1 Add `formatIssue(issue, parsedValue)` in `packages/core/src/index.ts`. Walks `issue.path`; renders `Workflow "<name>": <type> trigger "<name>": <suffix>` for `triggers[i]` paths, `Workflow "<name>": action "<name>": <suffix>` for `actions[i]` paths, `Workflow "<name>": <suffix>` for the workflow root, and a path-string fallback for anything else. Export from `@workflow-engine/core`.
- [x] 1.2 Add `.refine` on `workflowManifestSchema` rejecting `triggers.length === 0`. Suffix message: `must declare at least one trigger`.
- [x] 1.3 Add `.refine` on `workflowManifestSchema` rejecting duplicate trigger names within a workflow. Suffix message: `trigger names must be unique within a workflow` (and the issue path SHOULD point at `triggers` so `formatIssue` renders the workflow-root form).
- [x] 1.4 Add `.refine` on `workflowManifestSchema` rejecting duplicate action names within a workflow. Suffix message: `action names must be unique within a workflow`.
- [x] 1.5 Add `.refine` on `httpTriggerManifestSchema` walking `response.headers.properties` (when present) and rejecting any reserved header from `RESERVED_RESPONSE_HEADERS` (case-insensitive). Suffix message names the offending header.

## 2. Core: tests

- [x] 2.1 Unit test in `packages/core` for ≥1-trigger rule: a manifest with `triggers: []` fails `safeParse`; the issue's `formatIssue` rendering matches `Workflow "<name>": must declare at least one trigger`.
- [x] 2.2 Unit test for unique trigger names within a workflow (fail) and across workflows (pass).
- [x] 2.3 Unit test for unique action names within a workflow.
- [x] 2.4 Unit test for reserved http response headers: `Content-Type` declared in `response.headers.properties` fails; `x-app-version` passes.
- [x] 2.5 Unit tests for `formatIssue`: cron trigger schedule violation rendered with full context; workflow-root rule rendered without trigger context; reserved-header violation on http trigger rendered with `http trigger "<name>"` prefix; out-of-collection path falls back to path-string form.

## 3. SDK build: safeParse final pass + duplicate deletions

- [x] 3.1 In `packages/sdk/src/cli/build-workflows.ts`, at the end of `buildManifestFromMod` (after assembling the unsealed manifest), run `workflowManifestSchema.safeParse(built)`. For each issue in `result.error.issues`, call `buildContext.error(formatIssue(issue, built))` exactly once; do not short-circuit on the first issue.
- [x] 3.2 Delete the hand-written trigger-name regex check (the `TRIGGER_NAME_RE` `buildContext.error` block). Schema enforces this.
- [x] 3.3 Delete the hand-written action-name regex check. Schema enforces this.
- [x] 3.4 Delete the hand-written cron `schedule` non-empty `buildContext.error` block. Schema enforces this.
- [x] 3.5 Delete the hand-written cron `tz` non-empty `buildContext.error` block. Schema enforces this.
- [x] 3.6 Delete the hand-written reserved-http-response-headers `buildContext.error` block. Schema enforces this.

## 4. SDK build: tests

- [x] 4.1 Update existing `build-workflows.test.ts` cases that asserted on the old wording for the five deleted checks: each should now expect a `formatIssue`-rendered single-line string from the schema (substring match on the new form is fine).
- [x] 4.2 Add a `build-workflows.test.ts` case for a workflow file with a `defineWorkflow` and zero trigger exports: build fails with the `must declare at least one trigger` message.

## 5. Runtime upload: formatted field

- [x] 5.1 In `packages/runtime/src/api/upload.ts` (or wherever the registry surfaces 422 issues — see `workflow-registry.ts` and the `failureResponse` helper): when the registry's failure carries Zod `issues`, augment each entry with `formatted: formatIssue(issue, parsedManifest)`. Preserve `path` and `message` unchanged.
- [x] 5.2 If the parsed manifest is not in scope at the response site (e.g. parse failed before persistence), pass the raw input object — `formatIssue` reads only `triggers[i].type`, `triggers[i].name`, `actions[i].name`, and the workflow `name`; partial inputs degrade gracefully via the path-string fallback.

## 6. Runtime upload: tests

- [x] 6.1 Server-side test asserting that a 422 response for a hand-crafted manifest with empty triggers carries `issues[0].formatted` matching `Workflow "<name>": must declare at least one trigger`.
- [x] 6.2 Server-side test for a duplicate-trigger-name manifest: `formatted` matches the unique-names message.
- [x] 6.3 Server-side test confirming the structured `path` and `message` fields are still present alongside `formatted` (back-compat).

## 7. Documentation

- [x] 7.1 Add an entry to `docs/upgrades.md` describing: workflows with zero triggers / duplicate trigger names / duplicate action names / reserved-header declarations on `response.headers` will fail on next upload. Already-registered workflows continue running until the next upload attempt.
- [x] 7.2 If `workflows/src/demo.ts` happens to need a tweak (it should not — demo already declares triggers and conforms), update it. Otherwise note in the change summary that demo.ts is unaffected.

## 8. Validate

- [x] 8.1 Run `pnpm validate` (lint + check + test). All passes.
- [x] 8.2 Run `pnpm test:e2e` and confirm upload paths still pass; spot-check the 422 path includes `formatted`.
- [x] 8.3 Dev-probe: start `pnpm dev --random-port --kill`, parse port from the ready marker, attempt to `wfe upload` a fixture with zero triggers and confirm `wfe upload` surfaces the expected single-line error.
