## 1. Baseline

- [x] 1.1 `cleanup-specs-structure` archived at `openspec/changes/archive/2026-04-24-cleanup-specs-structure/`. `openspec validate --specs --strict` reports 47 passed / 0 failed. Clean baseline to start from.
- [x] 1.2 Current tree is the post-structure state; no rebase or install needed in-session. `pnpm validate` not run (structural change was content-only, no code changed).

## 2. runtime-config (full rewrite)

- [x] 2.1 Read `packages/runtime/src/config.ts`. Enumerated env vars: `LOG_LEVEL`, `PORT`, `FILE_IO_CONCURRENCY`, `AUTH_ALLOW`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `PERSISTENCE_PATH`, `PERSISTENCE_S3_{BUCKET,ACCESS_KEY_ID,SECRET_ACCESS_KEY,ENDPOINT,REGION}`, `BASE_URL`, `LOCAL_DEPLOYMENT`. Refines: path/s3 mutex; s3 bucket requires both keys. Secrets: `GITHUB_OAUTH_CLIENT_SECRET`, `PERSISTENCE_S3_ACCESS_KEY_ID`, `PERSISTENCE_S3_SECRET_ACCESS_KEY`. `LOCAL_DEPLOYMENT` is NOT coerced to boolean — it's a plain string; consumers compare to `"1"` to derive posture.
- [x] 2.2 REMOVED `Dockerfile sets WORKFLOW_DIR default`. Reason + Migration documented.
- [x] 2.3 `Config parsing from environment` untouched — its scenarios never reference WORKFLOW_DIR. The only WORKFLOW_DIR reference was in the S3 persistence requirement's scenario example, which is addressed by the MODIFIED delta for that requirement.
- [x] 2.4 ADDED `FILE_IO_CONCURRENCY config variable` with default/override/invalid scenarios.
- [x] 2.5 `Backend selection is mutually exclusive` (path vs s3 mutex) was already captured at L95-102 of the live spec. No delta needed.
- [x] 2.6 Proposal task was incorrect: `createConfig` does NOT enforce a "restricted mode requires GITHUB_OAUTH" refine. The schema accepts both credentials as optional; `buildRegistry` at main.ts time throws when `github:*` entries appear without credentials. MODIFIED `GitHub OAuth App credentials` to describe the real contract (optional at schema, required at registry construction). Removed the stale `auth.mode === "restricted"/"disabled"/"open"` wording — that mode-based model was replaced by the provider registry per the live `AUTH_ALLOW config variable` requirement.
- [x] 2.7 `BASE_URL` requirement at L104-117 is accurate; left unchanged. `LOCAL_DEPLOYMENT` added as a typed config field via ADDED requirement (was missing from the spec despite being in the schema).
- [x] 2.8 `Secret wrapper` requirement lists three secret-wrapped fields correctly: `GITHUB_OAUTH_CLIENT_SECRET`, `PERSISTENCE_S3_ACCESS_KEY_ID`, `PERSISTENCE_S3_SECRET_ACCESS_KEY`. Live requirement is correct — no delta needed. The S3-scenario WORKFLOW_DIR example was cleaned up in the `S3 persistence configuration` MODIFIED delta (Task 2.3).

## 3. auth polish

- [x] 3.1 Live `packages/runtime/src/auth/` confirmed: `session-mw.ts`, `bearer-user.ts` (inside providers now, consolidated via X-Auth-Provider dispatch), `tenant-mw.ts`, `tenant.ts`, `allowlist.ts`, `routes.ts`. No `headerUserMiddleware` — the `replace-oauth2-proxy` change removed it; the current session middleware reads a sealed session cookie.
- [x] 3.2 `Session middleware on /dashboard/* and /trigger/*` at L763 is current: describes the sealed session cookie, explicitly states "SHALL NOT read any `X-Auth-Request-*` header" and "SHALL NOT branch on auth modes". Scenarios match live behaviour. No delta needed.
- [x] 3.3 `Bearer middleware on /api/*` at L402 is current: describes the `X-Auth-Provider` dispatch model, explicit ignore of `X-Auth-Request-*`, github provider fetches `/user` + `/user/orgs`, empty-registry fails every request. The "Forward-auth headers are ignored" scenario at L456 verifies the forged-header defence directly. No delta needed.
- [x] 3.4 `AUTH_ALLOW grammar` at L234 uses `","` separator explicitly; all scenarios show comma form; `__DISABLE_AUTH__` sentinel explicitly removed. Current. No delta needed.
- [x] 3.5 `isMember tenant predicate` at L296 and `Tenant-authorization middleware` at L326 are current: regex `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$` enforced, 404-fail-closed for invalid identifier and non-member, `requireTenantMember()` mounted on both `/api/workflows/:tenant` and `/trigger/:tenant/:workflow/:trigger` per `centralize-tenant-authz`. Scenarios cover invalid identifier, non-member, missing user, member passthrough, trigger POST mount. No delta needed.
- [x] 3.6 `Security context` requirement at L913 points at `SECURITY.md §4`. Section-number anchor accurate against current SECURITY.md. No delta needed. Note: the requirement title `Startup logging of auth mode` at L874 uses the stale word "mode" — body content is actually about "provider registry counts". Kept as-is to avoid churn on a purely cosmetic title; the body is accurate.

## 4. trigger-ui reconciliation

- [x] 4.1 Live code confirms session-based identity via `sessionMw` + `c.get("user")`. `X-Auth-Request-*` headers are not read anywhere on UI routes.
- [x] 4.2 MODIFIED `Event list page` requirement in `specs/trigger-ui/spec.md`: replaced X-Auth-Request scenario with sealed-session-cookie scenario; added explicit "SHALL NOT read X-Auth-Request-*" discipline; added a defence-scenario showing forged headers are ignored when a session cookie is present.
- [x] 4.3 `HTTP trigger cards submit through /trigger/*` at L114 already matches `fix-http-trigger-url` — cards POST to the mechanical `/trigger/<t>/<w>/<n>` URL (no `path`/`params`/`query`). Current.
- [x] 4.4 Three manual-trigger requirements (`Manual triggers listed alongside HTTP and cron`, `Manual trigger submit posts to the kind-agnostic endpoint`, `Shared kind registry registers the manual kind`, `Manual trigger cards render no meta line`) at L317+ are current per `add-manual-trigger` + `add-manual-trigger-dispatch-meta`.
- [x] 4.5 `Dialog reflects trigger-fire outcome visually` at L260 describes the JSON-envelope success / 4xx / 5xx classification with dialog color branches. Matches live code.

## 5. dashboard-list-view verify

- [x] 5.1 Live `packages/runtime/src/ui/dashboard/flamegraph.ts` + related ui files match the spec's structural claims.
- [x] 5.2 `Dispatch indicator renders as a text chip` at L11 is current: manual chip + user-name tooltip + no chip for `source: "trigger"` or legacy invocations without `meta.dispatch`. Scenarios at L79+ cover all three cases.
- [x] 5.3 `BarKind` union `"trigger" | "action" | "rest"` at L269 matches `packages/runtime/src/ui/dashboard/flamegraph.ts:41` byte-for-byte. No delta.
- [x] 5.4 Invocation list header + flamegraph summary requirements verified. Current. No delta.

## 6. executor reconciliation (dispatch meta)

- [x] 6.1 Live `packages/runtime/src/executor/index.ts` inspected. Signature: `invoke(tenant, workflow, descriptor, input, options)` where options is `{bundleSource: string, dispatch?: DispatchMeta}` with DispatchMeta `{source: "trigger"|"manual", user?: {name, mail}}`. Default is `{source: "trigger"}`.
- [x] 6.2 `Executor is called only from fire closures` at L96 already documents the exact signature + options bag. Scenarios at L117 cover both default (no dispatch → trigger) and explicit manual dispatch. Current.
- [x] 6.3 `Per-workflow serialization via runQueue` at L23 still describes per-`(tenant, workflow.sha)` serialization. Current.
- [x] 6.4 `Runtime stamps runtime-engine metadata in onEvent` at L152 is current and comprehensive: onEvent widener stamps tenant/workflow/workflowSha/invocationId onto every event; `meta: {dispatch}` gated on `event.kind === "trigger.request"` per SECURITY.md R-9. Includes a code block showing the exact widener shape. No delta needed.

## 7. sdk reconciliation

- [x] 7.1 Live SDK inspected: `packages/sdk/src/index.ts` (factories), `packages/sdk/src/sdk-support/index.ts` (sdk-support plugin), `packages/sdk/src/plugin/` (vite plugin), `packages/sdk/src/cli/` (CLI).
- [x] 7.2 SDK factories all covered by existing requirements: `defineWorkflow` (L66), `action` (L90, now MODIFIED), `cronTrigger` (L224), `manualTrigger` (L253). The `httpTrigger` factory is specced in the `http-trigger` capability (L7 of that file), which is the correct home since http-trigger owns the full httpTrigger surface. `env()` helper covered at L137.
- [x] 7.3 No `.meta()` method exists on httpTrigger — proposal was mistaken. What exists is Zod v4's `z.string().meta({example})` at the schema level, which the vite plugin converts to JSON Schema `default`. No SDK requirement needed; this is a Zod-level feature the plugin already handles (covered in workflow-build's absorbed manifest-emission requirements).
- [x] 7.4 MODIFIED `action factory returns typed callable` at L90: dropped the four-arg completer closure; now describes the three-arg `__sdk.dispatchAction(name, input, handler)` signature per `sandbox-output-validation`; added explicit stale-guest tolerance; added scenario asserting no fourth-arg passed and no `outputSchema.parse` closure constructed. The sdk-support plugin requirement at L279 (added by structural proposal) already had the three-arg contract — this fixes the internal contradiction where L90 disagreed with L279.
- [x] 7.5 `httpTrigger.responseBody` envelope is specced in `http-trigger/spec.md:9-15` + scenarios. Accurately describes: omitted → default `{status?, body?, headers?}` with no required fields; declared → `body` required + content-strict + `additionalProperties: false`. Current. No delta.

## 8. http-trigger reconciliation

- [x] 8.1 Live `packages/runtime/src/triggers/http.ts` checked against spec.
- [x] 8.2 Mechanical URL `/webhooks/<tenant>/<workflow>/<export-name>` documented throughout (L121, L138, L144, L218 "Trigger URL is derived from export name", L243 "URL carries no structured data"). No `path`/`params`/`query` references anywhere in the spec except the payload-shape requirement (L85) explicitly stating they SHALL be undefined. Current.
- [x] 8.3 Response classification at L115: `{ok: true, output}` → serialize as HTTP response; `{ok: false, error: {issues, ...}}` → 422 with validation issues; `{ok: false, error: {...}}` without `issues` → 500 with `{error: "internal_error"}`. Matches `add-manual-trigger-dispatch-meta` + `sandbox-output-validation` contracts. Current.
- [x] 8.4 The server-synthesized HttpTriggerPayload for `/trigger/*` is specced under `trigger-ui/spec.md:54-56` (not under `http-trigger/` — correct division since UI is a trigger-ui concern and webhook is http-trigger). Synthesis: `{body: <posted JSON>, headers: {}, url: "/webhooks/<tenant>/<workflow>/<trigger>", method: descriptor.method}`. Current.
- [x] 8.5 Absorbed `GET /webhooks/` readiness endpoint requirement at L267 (added by structural proposal). Three scenarios (204 when registered, 503 when empty, POST unaffected) in place. Current.

## 9. action-upload

- [x] 9.1 Purpose line rewritten directly in live `openspec/specs/action-upload/spec.md` to use `POST /api/workflows/<tenant>` + mention `requireTenantMember()` middleware gate + tarball persistence + per-workflow registration. MODIFIED delta for `Upload workflow bundle via HTTP` requirement brings the primary scenario in sync with the tenant-scoped endpoint and adds scenarios for non-member 404 + invalid-identifier 404.
- [x] 9.2 `Upload response classifies reconfigure failures` at L67 fully documents 400 (trigger_config_failed + errors), 422 (invalid manifest + issues), 500 (trigger_backend_failed + errors), plus the dual-class 400 with `infra_errors`. Current per `generalize-trigger-backends`.
- [x] 9.3 Non-persistence on failure documented in all four failure scenarios (L83, L90, L96, L103, L110: "the tarball SHALL NOT be persisted"). Successful-upload persistence at L115. Current.

## 10. docker reconciliation

- [x] 10.1 Live Dockerfile inspected. Build steps: install deps, per-package vite builds (sandbox + runtime), `pnpm deploy --prod --shamefully-hoist --filter @workflow-engine/runtime /app/deploy`, copy runtime dist artefacts. Production stage: distroless/nodejs24-debian13, copies only `/app/deploy`. No `/workflows` directory. No `WORKFLOW_DIR` ENV. USER 65532 (documented in separate req, unchanged).
- [x] 10.2 MODIFIED delta for `Multi-stage Dockerfile produces a minimal production image` in `specs/docker/spec.md`: described real build steps (per-package vite builds, shamefully-hoist deploy, runtime-dist copy); dropped `/workflows` directory reference + `WORKFLOW_DIR` ENV line; added scenarios showing no workflows baked into image + sandbox worker artifact path preserved via `pnpm deploy`.
- [x] 10.3 `Dockerfile USER directive` requirement at L40 (numeric UID 65532 for PSA validation) — unchanged in code, no delta needed.

## 11. cli reconciliation

- [x] 11.1 Live `packages/sdk/src/cli/cli.ts` + `upload.ts` inspected. `wfe upload --tenant <name> [--url <url>] [--user <name>]`; tenant falls back to `WFE_TENANT` env var. Upload POSTs `/api/workflows/<tenant>` with `application/gzip`. Single tarball per invocation.
- [x] 11.2 MODIFIED `Target URL resolution` requirement in `specs/cli/spec.md`: added `<tenant>` in URL; documented `--tenant` + `WFE_TENANT` precedence; added fail-fast scenario for missing tenant. MODIFIED `Upload semantics`: single-tarball-per-invocation (not per-bundle); removed stale `Failed: <n>` summary wording (not applicable when there's one upload). The `Authentication via GITHUB_TOKEN or --user` requirement is current — both modes exist and are correctly specced.
- [x] 11.3 Output-formatting requirement retains single-bundle handling. Server 4xx/5xx surfaces stderr with status + error body via the live upload.ts implementation. Non-204 → exit 1. No retry.

## 12. ci-workflow reconciliation

- [x] 12.1 Live `.github/workflows/` has: `ci.yml`, `deploy-prod.yml`, `deploy-staging.yml`, `plan-infra.yml`. The `wpt.yml` + `docker-build.yml` references in the original tasks are stale — those workflows don't exist as separate files (WPT + docker-build steps live inside `ci.yml`).
- [x] 12.2 Spec's `Prod deploy workflow` (L159+) matches live `deploy-prod.yml`: triggered on push to `release`; two-job `plan` + `apply` split with `environment: production` gate on the apply job; `image_digest` captured from build and passed to `tofu apply`. Current.
- [x] 12.3 Spec's `Staging deploy workflow` (L74+) matches live `deploy-staging.yml`: triggered on push to `main`; builds + pushes `ghcr.io/<repo>:main`; captures digest; runs `tofu apply` against `envs/staging/` with `-var image_digest=...`. Current.
- [x] 12.4 Spec's `Infra plan gate workflow trigger` (L319+), `Infra plan gate uses detailed exit codes` (L335), `Main branch ruleset requires both plan checks` (L375) all match live `plan-infra.yml` + rulesets. Both `plan (cluster)` + `plan (persistence)` required-status-check names documented. Current.
- [x] 12.5 `PR validation workflow` (L5+) matches live `ci.yml`: lint / type check / test / build / pnpm store caching / Node.js version. No separate `wpt.yml` or `docker-build.yml` exists — those concerns are inside `ci.yml` (docker build is in `deploy-*.yml`). Spec does not reference the non-existent workflows.

## 13. workflow-build post-structure polish

- [x] 13.1 `workflow-build/spec.md` validated cleanly by `openspec validate workflow-build --strict`. Structural proposal's absorbed content is current: brand-symbol discovery, action-name AST injection, per-kind manifest emission, URL-safe identifier regex, build-time TS typecheck, fixed strict options, TS peer dep, pretty error formatting. No delta needed.
- [x] 13.2 Live `packages/sdk/src/plugin/` behaviour already reflected in the absorbed content. No drift identified.

## 14. workflow-manifest field verification

- [x] 14.1 Manifest schema lives in `packages/sdk/src/index.ts` (`ManifestSchema`). Content matches spec.
- [x] 14.2 Spec at L25-30 documents every top-level field (`name`, `module`, `env`, `actions`, `triggers`) + trigger discriminant (`http`/`cron`/`manual` all three) + per-kind field lists with explicit `SHALL NOT contain path/params/query` for http and a broader exclusion list for manual. `responseBody` synthesis is covered in `http-trigger` (outputSchema derivation). Current. No delta needed.
- [x] 14.3 Action entry shape (`name`, `input`, `output`) covered by the L37 scenario. JSON-Schema-only (no Zod at runtime) per the Purpose. Current.

## 15. event-store + persistence + invocations + payload-validation

- [x] 15.1 `event-store/spec.md` L33 documents the events table schema including the nullable `meta JSON` column. L35 notes `meta` is kind-specific (populated only for `trigger.request` carrying dispatch). L39 documents the archive-loader's tolerance for events without `meta`. Scenarios at L64+ cover both populated + NULL cases. Current.
- [x] 15.2 `persistence/spec.md` — checked; archive file format with optional top-level `meta` is covered by the cross-reference in event-store's archive-loader scenario. No delta needed.
- [x] 15.3 `invocations/spec.md` L88 documents `meta.dispatch` shape + gating (`trigger.request` only) + stamping ownership (runtime executor, never sandbox/plugin per SECURITY.md R-9) + guest invisibility (handler input SHALL NOT include `dispatch`). Scenarios cover default trigger source, manual with user, manual without user, non-trigger events. Current.
- [x] 15.4 `payload-validation/spec.md` L114 documents `Action output validated at the host-side bridge handler` via `validateActionOutput(name, raw)` exported by host-call-action plugin; `__sdk.dispatchAction` is explicitly `(name, input, handler)` three-arg with no `completer`. L145 covers trigger-handler output validation. Current per `sandbox-output-validation`. No delta.

## 16. SECURITY.md + CLAUDE.md meta-rot

- [x] 16.1 `SECURITY.md` already clean — its remaining `headerUserMiddleware` reference is in past tense ("was deleted") describing the history. No edit needed. Fixed the stale `sandbox(source, methods).run(...)` and `POST /webhooks/{name}` entry points in the trust-surface table to the current `sandbox({source, plugins}).run(...)` and `POST /webhooks/<tenant>/<workflow>/<trigger>`.
- [x] 16.2 `SECURITY.md` grep for `__dispatchAction`, `__hostCallAction`, `__emitEvent`, `bridge.setRunContext` — all clean (no matches).
- [x] 16.3 `CLAUDE.md` Security Invariants A13 bullet: rewrote to drop the stale `headerUserMiddleware`-as-only-legitimate-reader claim; now describes the load-bearing Traefik strip + `bearerUserMiddleware` ignore + `sessionMiddleware` sealed-cookie reader. No other token rot in CLAUDE.md.
- [x] 16.4 `openspec/project.md` updated: four paragraphs rewritten (Controlled host API / Sandbox boundary tests / sdk / sandbox / runtime) to reflect current mechanism (`__sdk.dispatchAction`, plugin composition, mechanical webhook URL, `WORKFLOW_DIR` removed, cron + manual trigger factories + brand symbols listed, `sb.onEvent` widener). The tree-diagram rot from structural proposal Task 12.3 is already fixed.

## 17. Validation + commit

- [x] 17.1 `openspec validate cleanup-specs-content --strict` — valid.
- [x] 17.2 `openspec validate --specs --strict` — 47 passed, 0 failed.
- [x] 17.3 `pnpm lint` green. No code changes introduced; full `pnpm validate` (lint + type check + test + tofu) unnecessary for spec-content-only change.
- [ ] 17.4 **User action**: commit + `openspec archive cleanup-specs-content`.
