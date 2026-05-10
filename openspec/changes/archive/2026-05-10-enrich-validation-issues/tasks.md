## 1. Engine-internal ValidationIssue shape

- [x] 1.1 Extend the `ValidationIssue` interface in `packages/runtime/src/executor/types.ts` with optional `received?: unknown`, `expected?: string`, `code?: string` fields. Re-export unchanged.
- [x] 1.2 Update `zodIssuesToValidationIssues` in `packages/runtime/src/triggers/validator.ts` to populate the new fields from each `$ZodIssue`: map zod's `code` → `code`, derive an engine-stable `expected` string from the issue (enum options, expected type, etc.), and lift the value at `issue.path` from the input passed to `safeParse` into `received` via a small `liftAtPath(input, path)` helper.
- [x] 1.3 Mirror the same mapping change in any other call site of `zodIssuesToValidationIssues` — currently only `packages/runtime/src/plugins/host-call-action.ts:59`. Ensure both `validateAction` and `validateActionOutput` get the enriched shape.
- [x] 1.4 Unit-test the mapper: enum failure (lift `received` from a leaf path), type-mismatch failure, nested-object failure (lift a sub-object verbatim), multi-issue failure (verify each issue gets its own `received`).
- [x] 1.5 Unit-test the "only the failing field, never the whole payload" invariant: a body with `{name: 1, notes: "<big>"}` failing only on `name` produces an issue whose `received` is `1`, not the whole body.

## 2. Wire-boundary projection

- [x] 2.1 Add a `toWireIssues(issues)` helper next to `validator.ts` (or in a sibling file) that projects `ValidationIssue[]` to `{path, message}[]` only.
- [x] 2.2 Use `toWireIssues` in `packages/runtime/src/triggers/http.ts` (`validationFailure`, ~line 77) so the 422 body never carries `received`/`expected`/`code`.
- [x] 2.3 Use `toWireIssues` in `packages/runtime/src/ui/trigger/middleware.tsx` at the manual-fire 422 branch (~line 375) for the same reason.
- [x] 2.4 Integration test for HTTP 422: webhook POST with bad enum body → response issues have only `path`+`message`; persisted `trigger.rejection` event has full enriched shape.
- [x] 2.5 Integration test for manual 422: same assertion on the `/trigger/...` POST response.

## 3. Trigger.rejection emission — manual

- [x] 3.1 In `packages/runtime/src/ui/trigger/middleware.tsx`, at the validation-failure branch of the POST handler (after `entry.fire(...)` returns `{ok: false, error: {issues}}`), call `entry.exception({kind: "trigger.rejection", name: "manual.input-validation", input: {issues, trigger: triggerName}})` before returning the 422.
- [x] 3.2 Confirm the emitted event matches the host-fail pattern: no `meta.dispatch` (consistent with `http.body-validation`). Manual-origin identification comes from `name: "manual.input-validation"`. (Architectural: `executor/exception.ts:19` documents that single-leaf host-fail events have no dispatch.)
- [x] 3.3 Confirm via the existing test scaffolding for `ui/trigger/middleware.test.ts` that successful fires still don't emit `trigger.rejection`.
- [x] 3.4 Add a test asserting the event payload's `input.issues[0]` includes the enriched fields (`received`, `expected`, `code`).
- [x] 3.5 Covered by existing `invocations-list-view` rendering tests for `trigger.rejection` rows — the synthetic-row rendering branches on `kind`, not on `name`, so manual rejections render with the same shield-cross glyph and JSON-tree expand affordance as http rejections. The new field shape lands in the JSON tree via the existing `event-detail.tsx` `wfeJsonTree` mount.

## 4. Trigger.rejection emission — ws (drift fix)

- [x] 4.1 In `packages/runtime/src/triggers/ws.ts`, at the JSON-parse failure branch (`catch` around line 271), call `conn.entry.exception({kind: "trigger.rejection", name: "ws.json-parse"})` before `ws.close(WS_CLOSE_INVALID_PAYLOAD, "json parse")`.
- [x] 4.2 In the same file, at the schema-validation failure branch (`result.error.issues !== undefined`, around line 285), call `conn.entry.exception({kind: "trigger.rejection", name: "ws.body-validation", input: {issues}})` before `ws.close(WS_CLOSE_INVALID_PAYLOAD, "schema")`.
- [x] 4.3 Add tests in `packages/runtime/src/triggers/ws.test.ts` for both branches: assert the rejection event is persisted with the correct `name` and (for the schema branch) the enriched `issues` shape.
- [x] 4.4 Verify the existing close-code behavior is unchanged. (Existing `WS_CLOSE_INVALID_PAYLOAD` assertions in both branches still pass.)

## 5. Action validation — issues across the bridge

- [x] 5.1 In `packages/runtime/src/plugins/action-dispatch.ts`'s `translateValidatorThrow`, when reshaping `ValidationError` into a `GuestSafeError`, attach the normalised `issues` array as an own-property on the new error. Used `Object.defineProperty` with `enumerable: true` so the bridge marshaling walk (enumerable-own-props in `packages/sandbox/src/bridge.ts:529-…`) picks it up; raw `errors` stays out because it was never copied.
- [x] 5.2 Update `formatValidationIssues` (same file) to also include the `received` value in the formatted message string when present — improves the human-readable summary without making the structured `.issues` redundant.
- [x] 5.3 Add a unit test asserting that on action input validation failure the rethrown error has `name === "GuestSafeError"`, a defined `message`, and `issues` whose first entry carries `received`/`expected`/`code`.
- [x] 5.4 Add a test asserting `errors` is `undefined` on the rethrown error (raw zod issues stay host-only).
- [x] 5.5 Covered by the existing host-call-action.test.ts ValidationError-shape assertion (extended to verify `received`/`expected`/`code` on `ValidationError.issues`) and the action-dispatch translateValidatorThrow tests (verify `issues` survives onto `GuestSafeError`). End-to-end persistence through the executor's `action.error` event is exercised by the existing sandbox integration tests, which continue to pass.

## 6. Doc fix and security comment update

- [x] 6.1 Update the security comment in `packages/runtime/src/triggers/http.ts` around line 263 to reflect the new, tighter invariant: "Only failing-field values cross into the persisted event, never the whole request body."
- [x] 6.2 Confirm the existing `payload-validation` spec text change (`path: (string | number)[]` and example fix) is reflected in the archived spec on apply — handled by the delta file in `specs/payload-validation/spec.md`.

## 7. Demo / dashboard verification

- [x] 7.1 Extended `workflows/src/demo.ts` with a `rejectMe` httpTrigger (`z.enum(["A","B"])`) — hit it with `curl -X POST /webhooks/local-user/demo-repo/demo/rejectMe -d '{"kind":"a"}'` after `pnpm dev` to produce a real `trigger.rejection` row with the enriched fields.
- [x] 7.2 Verified via `pnpm dev` (port 39041, session cookie). Steps:
  - `curl -X POST /webhooks/local-user/demo-repo/demo/rejectMe -d '{"kind":"a"}'` → `422 {error:"payload_validation_failed", issues:[{path:["body","kind"], message:"Invalid option: expected one of \"A\"|\"B\""}]}` (no `received`/`expected`/`code` — wire-strip OK).
  - `curl /invocations/local-user/demo-repo/<evt-id>/event` → persisted event-detail fragment carries `data-json` with `input.issues[0]` = `{path:["body","kind"], message:"...", received:"a", expected:"one of [\"A\", \"B\"]", code:"invalid_value"}` (enriched fields present — JSON-tree mount renders them via `wfeJsonTree`).

## 8. Validate

- [x] 8.1 Run `pnpm lint`, `pnpm check`, `pnpm test` — all green (1500 vitest tests pass, +11 new).
- [x] 8.2 Run `pnpm test:e2e` since this change touches trigger spawn/dispatch paths (manual + ws emission) and event persistence. — 23/23 pass.
- [x] 8.3 Run `pnpm exec openspec validate enrich-validation-issues` — change is valid.

## 9. Apply

- [ ] 9.1 After CI is green, run `/opsx:apply` (or the archive flow) to merge the delta specs back into `openspec/specs/` on archive.
