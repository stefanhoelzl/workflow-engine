## Context

The HTTP trigger router today compiles each trigger's `path:` argument into a `URLPattern` at `reconfigure()` time and maintains a two-pass lookup (static paths beat parameterized). Authors pick the path string; the plugin extracts named param identifiers from it and bakes them into the manifest; the runtime extracts matched groups into `payload.params` at request time. A parallel channel exists for query strings: the SDK accepts an optional `query:` Zod schema, the plugin emits a `query` JSON Schema into the manifest, and the runtime parses `URL.searchParams` into `payload.query` for handlers.

This is more ceremony than the problem warrants. Webhook URLs are opaque identifiers that external providers (GitHub, Stripe, Slack, Twilio, Cronitor, …) copy once from a config UI and never read again. The REST-shaped expressivity of `:param`/`*wildcard` is unused in our one demo workflow and invites a silent-conflict class: two triggers with the same `path:` in a single workflow both validate, both upload, and resolve non-deterministically at request time (whichever registered first wins; the other is dead code with no warning).

The `generalize-triggers` change (archived 2026-04-19) reshaped the trigger pipeline so each kind has its own `TriggerSource` and the executor is kind-agnostic; the more-recent `add-cron-trigger` change (archived 2026-04-21) landed a kind with mechanical URLs (`/trigger/<tenant>/<workflow>/<cron-name>`). HTTP is now the outlier: its URL shape alone among trigger kinds carries structured, author-chosen data.

## Goals / Non-Goals

**Goals:**

- Webhook URL is derived mechanically from three regex-constrained segments: `(tenant, workflow, export-name)`. No author-chosen URL fragment; no URL-derived structured data in the handler's payload.
- URL collisions within a workflow are impossible by construction, guaranteed at three independent levels (JS parser rejects duplicate exports; manifest Zod enforces unique trigger names per workflow; tenant Zod enforces unique workflow names per tenant).
- The URLPattern compilation path, `ExtractParams<T>` conditional-type machinery, and the query-string parsing path are deleted — not wrapped, not deprecated, not flagged.
- The `http-trigger` capability's `Public ingress security context` requirement is honored: SECURITY.md §3 is updated in the same change to reflect the new routing semantics (delete W8 + R-W6; replace the URLPattern mitigation with a "Closed URL vocabulary" mitigation; narrow the payload snippet).
- Tenants whose former `path:` matches the export name see zero external-config churn; tenants whose `path:` differed either update the provider-side URL or rename the export.

**Non-Goals:**

- `TriggerSource.reconfigure(view)` plugin contract shape — unchanged. The HTTP source just becomes simpler internally.
- Executor signature or `{ok, output} | {ok: false, error}` envelope — unchanged.
- Per-tenant `reconfigure` batching, upload-API error classification, sandbox output validation — separate proposals.
- Manifest-entity-identity cleanup (moving `name` from entry property to map key, applied symmetrically to actions/cron) — considered and explicitly parked as a candidate follow-up; out of scope here because it expands into `workflow-manifest`, `workflow-registry`, `executor`, and every test fixture, trading a focused proposal for a structural refactor.
- Backward-compat shim for the old `httpTrigger({path, ...})` signature — rejected; the project's pattern on every prior BREAKING change has been "clean cut + re-upload," and a shim would not reduce the re-upload cost.
- HEAD/OPTIONS auto-handling, per-trigger header allowlist, rate limiting — pre-existing gaps, tracked in SECURITY.md, not addressed here.
- Sandbox `URLPattern` polyfill removal — the polyfill (at `packages/sandbox/src/polyfills/entry.ts`) exists for guest code consumption and is unaffected.

## Decisions

### D1. URL shape is three regex-constrained segments

**Decision:** The URL is exactly `/webhooks/<tenant>/<workflow>/<trigger-name>` — three segments after `/webhooks/`, each matching `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/` (or the leading-digit-allowing tenant regex for tenant + workflow, which is the pre-existing constraint). Any URL with more or fewer segments returns 404. Lookup is a `Map<string, SourceEntry>.get()` keyed by the concatenated identifier.

**Alternatives considered:**

- _Keep `path:` as an optional suffix that defaults to the export name._ Rejected — preserves configuration surface that zero tenants need; every external provider accepts arbitrary URLs; optionality is worse than mechanical here because it lets authors re-introduce the collision class the change aims to eliminate.
- _Allow arbitrary trailing path segments after `<trigger-name>`._ Rejected — equivalent to keeping `*wildcard`; reopens the silent-conflict surface.
- _Key the Map by `(tenant, workflow, name, method)` tuple._ Rejected — adding method as a key dimension means method-mismatch becomes "no match" rather than "method not allowed," but today's behavior already returns 404 on method mismatch (to avoid trigger enumeration per SECURITY.md R-W5), so the method check lives at the descriptor level and the Map key stays three-dimensional.

### D2. Identifier regex: `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/`

**Decision:** Matches the tenant-regex shape (minus the leading-digit allowance, since JS identifiers cannot begin with a digit) for consistency across URL segments. Length-capped at 63 chars; three such segments plus the `/webhooks/` prefix and two slashes keep URLs well under any sensible limit.

**Alternatives considered:**

- _Tighter: camelCase only (`/^[a-z][a-zA-Z0-9]*$/`)._ Matches the stated convention in `openspec/project.md`, but enforces style via validation — the wrong tool (Biome owns style). Rejected because build-time validation should protect correctness invariants, not taste.
- _Looser: full JS identifier including `$`._ `$` is URL-safe and valid in JS identifiers; the case for rejecting it is weak. Rejected anyway as defense-in-depth against URL-looking characters we don't test against, and because `$` is rarely used in named exports that authors intend as webhook endpoints.

**Enforcement:** at two layers.

1. **Plugin (build-time):** `buildTriggerEntry` checks each export identifier against the regex; failure emits a clear `ctx.error` message matching the existing pattern (e.g., `Workflow "cronitor": trigger export name "$weird" must match /^[A-Za-z_][A-Za-z0-9_]{0,62}$/`).
2. **Manifest Zod (upload-time):** `httpTriggerManifestSchema.name` gains `.regex(nameRegex)`. Second line of defense if a bundle somehow bypasses the plugin or is hand-crafted.

### D3. Query strings: tolerated on input, opaque in payload

**Decision:** Query strings on incoming URLs pass through unchanged: they remain in `payload.url` as an opaque tail, and they do NOT produce a structured `payload.query` field. The `query:` Zod schema config on `httpTrigger()` is removed; the manifest `query` field is removed; `extractQueryParams()` and `HttpTriggerDescriptor.query` are removed. Handlers that need a query value call `new URL(payload.url).searchParams` explicitly.

**Rationale:** The URL is a pure routing key. Providers that append tracking params (AWS signatures, delivery IDs, `?X-Amz-Signature=...`) are accommodated by tolerating the query tail; they don't break routing or require config changes. But the URL carries no structured data to the handler — no URL-derived attacker surface beyond the opaque `url` string, which the sandbox already treats as untrusted per SECURITY.md §3.

**Alternatives considered:**

- _Keep the validated `query:` schema path._ Rejected — preserves a second structured-data channel on an attacker surface, with weaker ergonomics than body-encoded JSON. Body is strictly more expressive and already has the full Ajv validation path.
- _Strip query strings from `payload.url` too._ Rejected — breaks providers that sign the full URL (including query) for verification.

### D4. Clean cut, no compatibility shim

**Decision:** Remove the `path`, `params`, and `query` surfaces in one change. Old tarballs are rejected at upload. Old SDK signatures produce immediate build errors. `payload.params` / `payload.query` access produces immediate type errors.

**Rationale:** The project's pattern (see the `multi-tenant-workflows`, `bake-action-names-drop-trigger-shim`, `generalize-triggers`, `add-cron-trigger` upgrade notes in `CLAUDE.md`) is consistent BREAKING releases with explicit re-upload steps. A shim would require keeping `ExtractParams<T>` alive during the deprecation window — and since the TypeScript inference chain is one of the juicier cuts (~14 lines of template-literal conditional types, a real tsc cost), keeping it for compatibility-only would be the worst of both worlds.

### D5. Correctness-first framing in the upgrade note

**Decision:** `CLAUDE.md` upgrade note leads with the silent-conflict elimination (the correctness story), followed by the code-size delta as supporting evidence. It does NOT enumerate migration buckets or per-tenant playbooks — the project's one tenant greps-and-fixes build errors, which are immediate and actionable.

**Alternatives considered:**

- _Lead with "simplification / ~230 lines removed."_ Rejected — reads as refactoring-for-its-own-sake; doesn't explain why the BREAKING re-upload is worth the cost.
- _Include a four-bucket migration matrix (path-equals-export-name, path-differs, path-uses-params, path-is-literal)._ Rejected — verbosity with no reader; this project has one tenant, and build errors are self-locating.

### D6. SECURITY.md §3 edits in this change

**Decision:** Update SECURITY.md §3 in the same change set that modifies `http-trigger`. Specifically:

- Lines 844-846: replace the "URLPattern + `:param`/`*wildcard`" paragraph with "exact three-segment match on `(tenant, workflow, trigger-name)`; constant-time Map lookup; query strings tolerated but not parsed."
- Lines 850-852: narrow the payload snippet to `{ body, headers, url, method }`.
- Line 870 (W8 threat): DELETE the URL-parameter-injection row entirely. No URL-derived structured data reaches the handler.
- Line 895-896 (URLPattern mitigation): REPLACE with a positive "Closed URL vocabulary" mitigation describing the regex-constrained three-segment shape and the no-URL-derived-data guarantee.
- Line 916 (R-W6 residual risk): DELETE entirely.

**Rationale:** The `http-trigger` spec's `Public ingress security context` requirement explicitly mandates SECURITY.md updates for any change that "change[s] trigger-to-route mapping semantics" or "extend[s] the payload shape passed to the sandbox" — this change does both, in the simplifying direction.

### D7. Runtime descriptor keeps `name`; manifest entry keeps `name`

**Decision:** The manifest entry retains `name` as an explicit field (Option A from the exploration). The runtime `HttpTriggerDescriptor` retains `name` as an explicit field.

**Alternatives considered:**

- _Option B: map-keyed manifest (`triggers: { "<name>": { type, ... } }`)._ Structurally expresses uniqueness but expands the proposal into `workflow-manifest`, `workflow-registry`, `sandbox-store`, `executor`, and every test fixture. Also invites analogous cleanup for actions and cron triggers for consistency. Out of scope.
- _Option C: discriminant-split maps (`httpTriggers: {...}, cronTriggers: {...}`)._ Regression against the `generalize-triggers` uniform-discriminated-union shape. Rejected.

### D8. No new NEVER invariant in CLAUDE.md

**Decision:** The `Security Invariants` section of `CLAUDE.md` is not extended. The new URL-matching semantics are strictly stricter than the old ones (regex-constrained segments vs arbitrary URLPattern syntax), so existing invariants ("NEVER add authentication to `/webhooks/*`", "NEVER accept a `<tenant>` URL parameter without validating against the tenant regex AND the `isMember(user, tenant)` predicate") already cover the surface. Adding a rule like "NEVER weaken the three-segment match" would protect an implementation choice rather than a security invariant, and dilute the existing rules.

## Risks / Trade-offs

- **[Migration cost for tenants with `:param` or `*wildcard` paths]** → Mitigated by the build error being immediate and actionable: `payload.params` reads fail to typecheck, pointing the author to the required refactor (move the dynamic value into body or query via `new URL(payload.url).searchParams`). This project has one tenant whose workflow does not use params; broader tenants adopting the platform after this change never see the old surface.
- **[Provider-side webhook URL changes for tenants whose `path:` differed from export name]** → Mitigated by rename freedom: any tenant can set the export name equal to the old `path:` string (subject to the identifier regex) to preserve the URL; the demo cronitor workflow has `path: "cronitor"` and export `cronitorWebhook`, and the upgrade step is either `git sed 's/cronitorWebhook/cronitor/g'` or one update in the cronitor.io config UI.
- **[Loss of the `query:` validated-schema path]** → Accepted. Authors who need structured query-string data parse it manually. No schema-validation path exists for the parsed value; this is consistent with how handlers must already treat headers and the URL itself as untrusted per SECURITY.md §3.
- **[Build-error surface on rebuild]** → Authors who pass `path:`, `params:`, or `query:` to `httpTrigger` now see a TypeScript error (`Object literal may only specify known properties`). This is the intended migration signal. Authors reading `payload.params` or `payload.query` see `Property 'params' does not exist on type 'HttpTriggerPayload<...>'`. Both errors are fail-loud, point to the exact change needed, and do not require any runtime observation to diagnose.
- **[Query strings in `payload.url` may surprise handlers migrated from reading `payload.query`]** → Mitigated by the spec scenario and the upgrade note explicitly calling out the `new URL(payload.url).searchParams` idiom. Low-risk because typed access to `payload.query` was the only way to consume query data, and dropping it produces an immediate type error.
- **[Future trigger kinds adopting the same mechanical-URL shape]** → No impact this change. The cron trigger already uses `/trigger/<tenant>/<workflow>/<cron-name>`, and the HTTP-trigger alignment makes the platform pattern more consistent. Future kinds (mail, queue, etc.) would naturally follow.

## Migration Plan

Because the project runs a single tenant under operator control, the migration is operator-driven and linear:

1. **Land the change on `main`.** CI rebuilds, typechecks, and runs the full vitest suite. TypeScript surfaces every handler site reading `payload.params` or `payload.query` and every `httpTrigger` call passing `path:`/`params:`/`query:` as an immediate error. Fix these in the same PR.
2. **Update the demo workflow.** `workflows/src/cronitor.ts` drops `path: "cronitor"`. The URL becomes `/webhooks/<tenant>/cronitor/cronitorWebhook`. Optionally rename the export to `cronitor` to preserve the old URL.
3. **Update SECURITY.md §3.** In the same PR: delete W8 + R-W6 rows, replace the URLPattern mitigation paragraph with the "Closed URL vocabulary" paragraph, narrow the payload snippet.
4. **Add the `fix-http-trigger-url` upgrade note to `CLAUDE.md`.** At the top of the `## Upgrade notes` section.
5. **Staging deploy via CI.** The `Deploy staging` workflow rebuilds the image; the new runtime rejects any tenant tarball whose HTTP trigger manifest still carries `path`/`params`/`query` at upload validation with a clear 400 response.
6. **Re-upload the tenant.** `wfe upload --tenant <name>` against staging; confirm the UI renders trigger cards correctly and the webhook URL in the card matches `/webhooks/<tenant>/<workflow>/<export-name>`.
7. **Manual smoke.** `curl -X POST https://staging.workflow-engine.webredirect.org/webhooks/<tenant>/cronitor/cronitorWebhook -H 'Content-Type: application/json' -d '<fixture body>'` returns 202 (the demo handler's explicit status).
8. **Prod deploy.** Fast-forward `release` to `main`; approve the required-reviewer gate on the `production` environment; monitor the `kubectl wait --for=condition=Ready certificate` step. After the rollout, re-upload the prod tenant if a different tenant config is in use, and update the cronitor.io webhook target URL to `/cronitorWebhook` (or leave it unchanged if the export was renamed to `cronitor`).

**Rollback:** `git revert <change-sha>` on `release` → `git push origin release` → approve the rebuild. The prior runtime validates the current tenant tarball without issue (the pre-change manifest schema is strictly looser than the post-change one, so re-upload is not required on rollback).

## Open Questions

None. All design threads raised during exploration were closed:

- Identifier regex → MIDDLE strictness (`/^[A-Za-z_][A-Za-z0-9_]{0,62}$/`).
- Shim vs clean cut → clean cut.
- Dead-code removal budget → remove all, including query parsing.
- Upgrade note tone → terse, correctness-first, no bucket matrix.
- SECURITY.md delta → W8 deleted, R-W6 deleted, positive "Closed URL vocabulary" mitigation added.
- Manifest entity identity → keep `name` as entry property (Option A); follow-up change may revisit uniformly.
