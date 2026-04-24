## Why

After `cleanup-specs-structure` lands, the spec directory's shape is correct but the content of ~10 runtime-facing specs still carries rot accumulated across recent upgrade notes. `runtime-config` documents a `WORKFLOW_DIR` environment variable that no longer exists in `packages/runtime/src/config.ts` and omits `FILE_IO_CONCURRENCY`, the `path/s3` mutex, the restricted-mode missing-credential refine, and the `LOCAL_DEPLOYMENT` gate. `trigger-ui` scenarios still read `X-Auth-Request-User:` headers for identity even though `sessionMiddleware` owns `/trigger/*` and the `replace-oauth2-proxy` change deleted `headerUserMiddleware` entirely. `action-upload`'s Purpose line references `POST /api/workflows` without the tenant prefix that has been required since `multi-tenant-workflows`. `http-trigger`, `executor`, and `sdk` predate `add-manual-trigger-dispatch-meta`'s internal-contract changes (the `fire(input, dispatch?)` signature, the `invoke(..., { bundleSource, dispatch? })` envelope, the UI-HTTP-trigger reroute). Several recent changes (`auth-allow-comma-separator`, `centralize-tenant-authz`, `fix-http-trigger-url`, `sandbox-output-validation`, `refresh-trigger-and-dashboard-ui`) have touched surfaces whose specs have not all caught up.

This is the second of three cleanup proposals. It reconciles spec content against current code for every runtime-facing capability except `infrastructure`, which is large enough to warrant its own proposal (`cleanup-specs-infrastructure`). It applies after `cleanup-specs-structure` and is independent of `cleanup-specs-infrastructure`.

## What Changes

- **MODIFIED** `runtime-config`: rewrite against `packages/runtime/src/config.ts`. Add `FILE_IO_CONCURRENCY` requirement; remove `WORKFLOW_DIR`-related requirement + scenario; document the `PERSISTENCE_PATH`/`PERSISTENCE_S3_BUCKET` mutex refine; document the restricted-mode missing-OAuth-credentials refine; document the `LOCAL_DEPLOYMENT` gate (referenced by `SECURITY.md §6`); ensure every `z.string().transform(createSecret)` field is covered by the secret-wrapper requirement.
- **MODIFIED** `auth`: polish the session-middleware requirement against current `packages/runtime/src/auth/session-mw.ts` (no `headerUserMiddleware`, only `sessionMiddleware` and `bearerUserMiddleware`). Verify the `AUTH_ALLOW` grammar matches `auth-allow-comma-separator` (comma separator, not semicolon). Verify the `isMember` + tenant-regex requirements match `tenant-mw.ts`.
- **MODIFIED** `trigger-ui`: rewrite the identity-source scenario (currently reads `X-Auth-Request-User:` + `X-Auth-Request-Email:`) to use the sealed session cookie via `sessionMiddleware`. Verify the "HTTP trigger cards submit through /trigger/*" requirement matches `fix-http-trigger-url`'s UI reroute. Verify the manual-trigger requirements match the code added by `add-manual-trigger` + `add-manual-trigger-dispatch-meta`.
- **MODIFIED** `dashboard-list-view`: verify the manual-dispatch chip and flamegraph "triggered by \<name\>" requirements match the post `add-manual-trigger-dispatch-meta` implementation. Low expected churn — specs look recent. Tighten any scenarios that reference removed event fields.
- **MODIFIED** `executor`: update `invoke` signature requirement to `invoke(tenant, workflow, descriptor, input, { bundleSource, dispatch? })`. Document the `sb.onEvent` widener's role as the sole runtime attacher of `tenant`, `workflow`, `workflowSha`, `invocationId`, and `meta.dispatch` (per `SECURITY.md §2 R-8`, R-9). Confirm the per-`(tenant, sha)` RunQueue serialization requirement is present.
- **MODIFIED** `sdk`: post-structural-fold this capability already holds the sdk-support plugin requirements. Reconcile against the current SDK surface: `defineWorkflow({env})`, `action({name, input, output, handler})`, `httpTrigger({method?, body?, responseBody?, handler})`, `cronTrigger({schedule, tz?, handler})`, `manualTrigger({input?, output?, handler})`. Add an ADDED requirement covering `httpTrigger.meta({example})` per `trigger-ui-example-values`. Verify the three-arg `__sdk.dispatchAction(name, input, handler)` signature per `sandbox-output-validation` (no `completer` parameter).
- **MODIFIED** `http-trigger`: reconcile against `fix-http-trigger-url` (mechanical `/webhooks/<tenant>/<workflow>/<export>` URL, no `path`/`params`/`query`), `add-manual-trigger-dispatch-meta` (default `dispatch = {source: "trigger"}`, 422/500 handler-vs-client classification, `responseBody?: z.ZodType` optional content-strict envelope). Absorb webhooks-status content fully (structural proposal only moved the requirements; content-level polish happens here if needed).
- **MODIFIED** `action-upload`: fix Purpose line to `POST /api/workflows/<tenant>`. Verify the 400/422/500 trigger-backend classification requirement matches `generalize-trigger-backends`.
- **MODIFIED** `docker`: drop the `WORKFLOW_DIR=/workflows` ENV line. Reconcile against current `infrastructure/Dockerfile` (structure proposal adds the missing Purpose; content proposal verifies the requirements are accurate).
- **MODIFIED** `cli`: reconcile `wfe upload --tenant <name>` requirement. Verify the multi-tenant-aware upload flow matches `packages/sdk/src/cli.ts`.
- **MODIFIED** `ci-workflow`: reconcile against `automate-prod-deployment` (release-branch flow, deploy-prod.yml two-job split, `image_digest` injection) and `guard-infra-drift` (`plan-infra.yml` + `main` ruleset required status checks `plan (cluster)` + `plan (persistence)`).
- **MODIFIED** `workflow-build`: after the structural proposal absorbed deleted-spec content, reconcile any remaining drift against `packages/sdk/src/vite-plugin/` real behaviour. Low expected churn.
- **MODIFIED** `workflow-manifest`: after the structural proposal adds the Purpose, verify every field documented (`name`, `module`, `env`, `actions`, `triggers`) matches `packages/sdk/src/manifest-schema.ts`. In particular confirm: `triggers` discriminant union includes `http` / `cron` / `manual` (all three kinds); action `inputSchema` + `outputSchema` are JSON Schemas (no Zod runtime in the manifest); trigger URL no longer has `path`/`params`/`query` fields.
- **MODIFIED** `event-store`: verify the events table includes the nullable `meta JSON` column added by `add-manual-trigger-dispatch-meta`. Verify the tenant-scoped query API (`EventStore.query(tenant)`) per `tenant-scoped-event-store-reads`.
- **MODIFIED** `invocations`: verify `InvocationEvent extends SandboxEvent` shape, `meta.dispatch` stamped host-side only (SECURITY.md R-9).
- **MODIFIED** `payload-validation`: verify the Ajv-on-host + JSON-schema manifest contract post `sandbox-output-validation`. Confirm the two validation modes (trigger output, action input + output) are both documented.
- **MODIFIED** `persistence`: verify the archive file format carries the optional `meta` top-level field (add-manual-trigger-dispatch-meta).
- **MODIFIED** `SECURITY.md` references (not a capability, but a cross-file reconciliation task). Grep for `headerUserMiddleware`, `__dispatchAction`, `__hostCallAction`, `__emitEvent`, `bridge.setRunContext` in `SECURITY.md` and `CLAUDE.md`; update to current names. This is the "meta-rot" identified in explore thread 2.

## Capabilities

### New Capabilities
(None — this proposal reconciles existing specs.)

### Modified Capabilities
- `runtime-config`: content rewrite to match `packages/runtime/src/config.ts`.
- `auth`: scenario + middleware-name polish against current `packages/runtime/src/auth/`.
- `trigger-ui`: identity-source scenario rewrite (session cookie, not forward-auth header).
- `dashboard-list-view`: verify against current flamegraph + manual-chip implementation.
- `executor`: update `invoke` signature + `sb.onEvent` widener + RunQueue requirements.
- `sdk`: reconcile SDK surface incl. `httpTrigger.meta`, three-arg dispatcher, `responseBody` envelope.
- `http-trigger`: reconcile against `fix-http-trigger-url` + `add-manual-trigger-dispatch-meta`.
- `action-upload`: Purpose + response-shape classification.
- `docker`: remove `WORKFLOW_DIR` + reconcile against current Dockerfile.
- `cli`: verify `wfe upload --tenant` flow.
- `ci-workflow`: reconcile against `automate-prod-deployment` + `guard-infra-drift`.
- `workflow-build`: reconcile post-structural-absorption.
- `workflow-manifest`: verify field-by-field against `manifest-schema.ts`.
- `event-store`: `meta JSON` column + tenant-scoped query API.
- `invocations`: `InvocationEvent` shape + `meta.dispatch` R-9 discipline.
- `payload-validation`: Ajv-on-host + two-mode validation.
- `persistence`: archive `meta` field.

## Impact

- **Specs.** ~17 capabilities touched. `openspec validate --specs --strict` should stay at 0 failures after this proposal applies. No capability names change; no capabilities are created or removed.
- **Code.** None. Spec-content-only.
- **Cross-file docs.** `SECURITY.md` and `CLAUDE.md` edits for meta-rot (deleted `headerUserMiddleware` reference, stale bridge names). No new SECURITY.md section; only in-place name corrections.
- **Tenants.** None.
- **Ordering.** Applies after `cleanup-specs-structure`. Independent of `cleanup-specs-infrastructure`.
