## Context

`packages/runtime/src/triggers/validator.ts:17` (`zodIssuesToValidationIssues`) is the single chokepoint where zod validation issues become engine-shape `ValidationIssue` objects. Today it keeps only `path` and `message`, dropping `code`, `received`, `expected`, and `options`. That mapper feeds every validation surface in the engine:

```
   zod $ZodIssue[]              ← zod
        │
        ▼
   zodIssuesToValidationIssues  ← validator.ts (lossy)
        │
        ▼
   ValidationIssue[]            ← engine type
        │
        ├─ buildFire input validate         (triggers/build-fire.ts)
        ├─ buildFire output validate         (triggers/build-fire.ts)
        ├─ host-call-action validateAction   (plugins/host-call-action.ts)
        └─ host-call-action validateOutput   (plugins/host-call-action.ts)
```

Downstream of `buildFire`, each `TriggerSource` decides what to do with `result.error.issues`:
- `triggers/http.ts:259` returns 422 to the caller AND emits a `trigger.rejection` event.
- `ui/trigger/middleware.tsx:373` returns 422 to the dashboard caller; emits nothing.
- `triggers/ws.ts:285` closes the socket with `1007`; emits nothing despite the spec saying it must.
- Cron and imap don't surface validation failures meaningfully (host-constructed input — failure means engine bug).

For action validation, `plugins/host-call-action.ts:85` throws `ValidationError(message, issues, errors)`; `plugins/action-dispatch.ts:105` (`translateValidatorThrow`) collapses that to `new GuestSafeError(formatValidationIssues(issues))` — issues are erased before the throw reaches the executor's `action.error` event recording.

The persisted-event surface is governed by:
- `payload-validation/spec.md:65-67` — `issues` array shape (`path` array + `message` string)
- `payload-validation/spec.md:81-83` — HTTP 422 response shape and the "no library-specific details on the wire" rule (§83)
- `actions/spec.md:282` — "`.errors` and `.issues` SHALL NOT be exposed across the bridge"
- `ws-trigger/spec.md:115,120` — already requires `trigger.rejection` emission on ws validation failure (current code does not implement)

## Goals / Non-Goals

**Goals:**

- Enrich the engine-internal `ValidationIssue` shape so failing values, expected constraints, and zod codes survive into persisted events.
- Make the dashboard's expanded `trigger.rejection` view answer "what value was rejected and why" without re-running the request.
- Keep the wire (HTTP/manual 422 response) minimal, library-agnostic, and free of zod-specific identifiers. §83 stays binding.
- Make `trigger.rejection` emission symmetric across caller-input trigger kinds (http, ws, manual) so dashboard authors see all caller-side validation failures in one place.
- Carry enriched issues into `action.error` events via the existing `GuestSafeError` throw path.

**Non-Goals:**

- Cron and imap rejection events. Their input is host-constructed; validation failure is an engine bug, not author-actionable.
- Changing the human-readable summary text in `summarizeIssues` (`ui/invocations/middleware.tsx:272`) or `summariseIssues` (`triggers/build-fire.ts:47`). Tooltip prose stays as today.
- Introducing a size cap, redaction, or provenance tag on the persisted `received` value. Failing-field-only persistence is the agreed PII boundary.
- Author-facing SDK changes. Authors don't gain a new API; they gain richer fields on objects they already see.

## Decisions

### D1. Enrich `ValidationIssue`, not introduce a new type

Add optional fields to the existing `ValidationIssue` interface in `packages/runtime/src/executor/types.ts:92`:

```ts
interface ValidationIssue {
    readonly path: readonly (string | number)[];
    readonly message: string;
    readonly received?: unknown;   // value lifted from input at path
    readonly expected?: string;    // human-readable expected constraint
    readonly code?: string;        // engine-stable issue code (mirrors zod's)
}
```

**Alternative considered:** a separate `RichValidationIssue` shape, projected to the existing shape at serialization boundaries. Rejected — adds a second mapping and two type names where one suffices. The optional-fields approach keeps backward compatibility automatic (existing consumers ignore the new fields).

### D2. Strip at the wire boundary, not at the source

The mapper (`validator.ts`) always emits the rich shape. Each `TriggerSource` that builds an HTTP response body projects to `{path, message}` at the point of `c.json(...)`. The persisted event payload (`entry.exception({kind: "trigger.rejection", input: {issues, ...}})`) keeps the rich shape.

**Why not strip in the mapper and re-enrich elsewhere?** The mapper has access to the zod issue directly; re-enriching later would require carrying the raw zod issue across the codebase or re-running the validator. Strip-on-output is the natural seam.

**Where projection happens:**
- `triggers/http.ts:77` — `validationFailure` projects before building the 422 body.
- `ui/trigger/middleware.tsx:375` — same projection inline before `c.json(...)`.
- `triggers/ws.ts` close-reason path — no projection needed (only emits a status code + short reason string).

A single `toWireIssues(issues)` helper lives next to `validator.ts` to keep the projection in one place.

### D3. `received` is the value at `issue.path`, lifted from the validator's input

Zod's `$ZodIssue.received` is a coarse type tag (e.g. `"string"`, `"number"`, `"object"`) — not the actual value. Authors want the actual value. The mapper lifts it by walking `issue.path` into the input that was passed to `safeParse`:

```ts
function liftAtPath(input: unknown, path: readonly (string|number)[]): unknown {
    let cur: unknown = input;
    for (const seg of path) {
        if (cur == null) return undefined;
        cur = (cur as Record<string|number, unknown>)[seg];
    }
    return cur;
}
```

If the path is empty (e.g. top-level type mismatch where the entire input is wrong), `received` is the entire input. For "only the failing field, never the whole payload" to hold, the *path* must be non-empty for caller-supplied trigger sources in practice. We rely on schema shape: caller-supplied triggers wrap the body in an object schema (e.g. `z.object({body: schema})`), so `issue.path` is never empty in those cases.

**Alternative considered:** carry zod's `received` (coarse type tag) instead of lifting the actual value. Rejected — defeats the purpose; the author already knows the type was wrong from `message`.

### D4. Carry `received` for object/array failures verbatim

If the failing path points at a sub-object that doesn't satisfy a nested schema, `received` is that sub-object as-is. No truncation, no stringification. The persisted event store handles arbitrary JSON; the dashboard JSON-tree renders it natively. Decision per interview: "no cap".

**Risk acknowledged below in R1.**

### D5. Action validation: attach `issues` to `GuestSafeError`, amend `actions/spec.md:282`

`translateValidatorThrow` in `plugins/action-dispatch.ts:105` constructs a new error from `ValidationError`. Extend the `GuestSafeError` instance (or a thin subclass) with an `issues: ValidationIssue[]` own-property. The bridge marshaling in `packages/sandbox/src/bridge.ts` walks enumerable own props (line 529 comment); `issues` will cross into the guest as a structured array.

**Why this is consistent with the bridge rule's intent:** The schema originated in author code (rehydrated from the manifest), the value is the guest's own argument or return, the path is into a guest-defined shape, and the message is zod's stock text. No host-internal data leaks. Amend `actions/spec.md:282` narrowly:

> The dispatcher SHALL catch the host-side `ValidationError` and rethrow as a `GuestSafeError` carrying a `.issues` array of the normalised validation-issue shape (`{path, message, received?, expected?, code?}`). The dispatcher SHALL NOT expose `ValidationError`'s underlying `.errors` field (raw zod issues) across the bridge.

The "no `.errors`" half of the rule is retained because raw zod issues are explicitly a host implementation detail.

**Alternative considered:** a side-channel where `host-call-action` writes the issues to a per-invocation context that the executor reads when recording `action.error`. Rejected — more moving parts, and the user's instinct ("validation issues are guest-safe, just put them on the error") matches the simpler model.

### D6. Manual trigger emits `trigger.rejection`

In `ui/trigger/middleware.tsx`, at the failure branch (around line 374), before returning the 422, call `entry.exception({kind: "trigger.rejection", name: "manual.input-validation", input: {issues, trigger: triggerName}})`. Dispatch context is `{source: "manual", login}` (already built earlier as `dispatch`).

Naming follows the `<source>.<reason>` convention used by http:
- `http.body-validation` (existing)
- `manual.input-validation` (new)
- `ws.body-validation` (new)
- `ws.json-parse` (new — covers the JSON-parse failure before validation, mirroring `ws-trigger/spec.md:115`)

### D7. WS trigger emits `trigger.rejection` (implementation catch-up)

In `triggers/ws.ts`, the JSON-parse failure branch (around line 271) and the validation-failure branch (around line 285) each call `conn.entry.exception({kind: "trigger.rejection", name: "ws.json-parse" | "ws.body-validation", input: {...}})` before closing the socket. The exception emission happens via `entry.exception`, the same channel http uses, so persistence/dashboard wiring is uniform.

**No spec change needed for ws-trigger** — the existing spec at `ws-trigger/spec.md:115,120,139,146` already mandates this. The change ships scenarios validating the new event payload shape (issues with `received`, etc.).

### D8. Doc fix: `path` type in `payload-validation/spec.md`

Replace line 81's `path: string` with `path: (string | number)[]`, and the example on line 90 from `"path": "orderId"` to `"path": ["orderId"]`. Pure doc correction.

## Risks / Trade-offs

- **R1. Pathological `received` size.** A caller's misclassified field could be a multi-MB string or deeply nested object. Persisting it verbatim bloats the event row and slows the dashboard JSON-tree render. **Mitigation:** accepted as-is per the interview decision ("no cap"). If this hurts in practice, a cap is a localized follow-up — confined to `liftAtPath` or the `toEventIssues` helper. Tracked as future work.

- **R2. Asymmetry between wire response and persisted event.** The HTTP caller sees `{path, message}` while the dashboard author sees `{path, message, received, expected, code}`. **Mitigation:** the asymmetry is by design and documented in `payload-validation/spec.md` §83 (the wire-minimisation rule). The author needs the value; the caller already has it.

- **R3. Bridge rule amendment widens what crosses into the guest.** The narrowed `actions/spec.md:282` still allows the engine-shape issue array (`{path, message, received?, expected?, code?}`) to reach guest catch blocks. **Mitigation:** the content is provably guest-owned (schema from author, value from guest input). The `.errors` field (raw zod issues) remains banned.

- **R4. Manual rejection events double-up author awareness.** The dashboard form already shows the 422 response inline; now there's also an invocations-list row. **Mitigation:** intentional. Persistence gives the failure a permanent location and lets the author find it again later. Symmetric with http.

- **R5. Ws drift fix changes observable behavior.** Ws clients today see only a `1007` close; after this change, the engine also emits a `trigger.rejection` event. **Mitigation:** the spec already required this; consumers (e.g., the dashboard) only gain rows, never lose them.

- **R6. Spec-clauses elsewhere assume the old shape.** Some scenarios in `invocations-list-view/spec.md` quote example payloads like `{path: ["name"], message: "Required"}`. **Mitigation:** these remain valid (new fields are optional); we update one or two fixtures to demonstrate the new fields rendering in the JSON tree, but the existing fixtures don't need to change.
