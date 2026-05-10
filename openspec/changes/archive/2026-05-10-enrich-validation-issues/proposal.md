## Why

When a caller's payload is rejected by a trigger's input schema, the persisted `trigger.rejection` event and the corresponding HTTP response carry only the failure path and a stock zod message (e.g. `body.type: "Invalid option"`). The author cannot tell what value was actually rejected without re-running the request, which defeats the whole point of having a dashboard view of rejections. The mapper at `packages/runtime/src/triggers/validator.ts:17` drops zod's `received`, `expected`, and `code` fields on every issue. The same erasure happens for action input/output validation: the `action.error` event persists only a flat string built from the same path-plus-message shape.

## What Changes

- Extend the engine-internal `ValidationIssue` type with optional `received`, `expected`, and `code` fields. The mapper at `validator.ts` populates them from zod's `$ZodIssue`; the value at `issue.path` is lifted from the input as `received` (full value, no cap, per-issue — never the whole payload).
- Persist the enriched issues on `trigger.rejection` and `action.error` events so the dashboard's expanded JSON-tree view shows the rejected value, the zod code, and what was expected.
- Project to a minimal `{ path, message }` shape at the wire boundary (HTTP 422 body, manual 422 body). Keeps `payload-validation/spec.md` §83 ("response SHALL NOT expose library-specific error details") intact: enrichment is author-facing in events, not caller-facing on the wire.
- Add `trigger.rejection` emission to the manual-fire path (`packages/runtime/src/ui/trigger/middleware.tsx`) under name `manual.input-validation`, dispatch `{source: "manual", login}`. New behavior.
- Implement `trigger.rejection` emission in the ws trigger source (`packages/runtime/src/triggers/ws.ts`) under name `ws.body-validation` and `ws.json-parse`. The `ws-trigger` spec already requires this; the runtime never implemented it — this change closes the drift.
- Carry the enriched issues across the action validation throw: attach `issues` to the `GuestSafeError` produced by `translateValidatorThrow` in `packages/runtime/src/plugins/action-dispatch.ts`. The content is guest-data + guest-schema, so propagation respects the intent of `actions/spec.md:282` (anti-host-leak). The literal rule text is amended narrowly to permit this case.
- Fix `payload-validation/spec.md:81` and its example (line 90) where `path` is documented as `string` but is, and always has been, `(string | number)[]` in the runtime. Doc rot, not a behavior change.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities

- `payload-validation`: `ValidationIssue` shape extended with optional `received`/`expected`/`code`; HTTP 422 response shape clarified to remain `{path, message}` only (strip-at-boundary rule); doc fix for `path` type and example.
- `actions`: `ValidationError.issues` shape extended; bridge rule (`dispatchAction surfaces failures via GuestSafeError hierarchy`, item 2) narrowed so the enriched issue shape may cross the bridge (content is guest-owned by construction); raw zod `errors` still banned.
- `manual-trigger`: new requirement to emit `trigger.rejection` event with name `manual.input-validation` when input fails validation; dashboard caller still receives the existing 422 response.

Implementation-only catch-up (no spec delta): `ws-trigger` (existing requirement at `ws-trigger/spec.md:115,120,139,146` already mandates emission — runtime never implemented it); `invocations-list-view` (existing expansion requirement already covers the new fields by virtue of rendering whatever JSON is on the event).

## Impact

- **Runtime code**: `packages/runtime/src/executor/types.ts` (issue type), `packages/runtime/src/triggers/validator.ts` (mapper), `packages/runtime/src/triggers/http.ts` (strip-at-boundary), `packages/runtime/src/triggers/ws.ts` (rejection emission), `packages/runtime/src/ui/trigger/middleware.tsx` (manual rejection emission + strip), `packages/runtime/src/plugins/host-call-action.ts` (ValidationError enrichment), `packages/runtime/src/plugins/action-dispatch.ts` (issues onto GuestSafeError).
- **No data migration**: new fields are optional on the persisted event payload; existing rows render unchanged.
- **No SDK surface change**: workflow authors don't see a new API. The new fields appear on issue objects already exposed via `ValidationError` and on the persisted event JSON.
- **Security**: persisted events now contain caller-supplied values at the failing path. The "only the failing field, never the whole payload" rule keeps PII surface narrow; `http.ts:263`'s comment is updated to reflect the new, tighter invariant.
- **Tests**: validator mapper unit test, per-source rejection-emission tests (http already covered; add manual + ws), strip-at-boundary tests for HTTP and manual 422 responses, action-dispatch test asserting `GuestSafeError.issues` carries the enriched shape.
