## Context

Prod and staging both run on one Scaleway VPS (Caddy + two rootless Podman/Quadlet apps; see the `infrastructure` capability). We want first-hand experience of bunny.net Magic Containers before considering it for prod. This change stands up a **staging-only** Magic Containers deployment to develop intuition about how the platform actually behaves — CDN caching, container resource visibility, volume durability, OAuth round-trips — against our real image. It is a **spike**, not a hardening exercise: the explicit posture (settled in `/openspec-explore`) is *deploy it, use it, observe*, not *pre-build defenses around failure modes we haven't seen*.

The app itself needs no code change: it already serves `/readyz`, sends `Cache-Control` only on `/static/*`, reads config from env vars, and persists a DuckDB EventStore + uploaded bundles under `PERSISTENCE_PATH`.

## Goals / Non-Goals

**Goals:**
- Run staging on Magic Containers via the `bunnynet` OpenTofu provider: one app, one `/data` volume, CDN endpoint, env from existing staging secrets, `/readyz` probe, one EU region, one replica.
- Serve `staging.workflow-engine.webredirect.org` from Bunny by re-targeting a single Dynu record; keep all VPS staging code running as a warm fallback.
- Wire the staging deploy pipeline to roll Bunny forward on each `:main` push.
- Observe real behavior cheaply: CDN cache headers on dynamic vs `/static/*` routes; container memory/cpu visibility; OAuth login.

**Non-Goals:**
- Touching prod (stays entirely on the VPS).
- Any app/runtime code change — no DuckDB `memory_limit` wiring, no manifest/sandbox changes.
- Durability instrumentation (sentinels, forced-reschedule provocation). Accept-loss is the stated posture; staging data is low-stakes and the deploy pipeline reseeds bundles anyway.
- A `staging_backend` toggle variable, multi-region, autoscaling >1, backups/replication, or Anycast (unless the cache observation forces it).
- Migrating staging event history off the VPS.

## Decisions

### D1 — Staging-only, parallel to the VPS; cutover = one DNS record
Add the bunnynet resources; the **only** edit to existing infra is the staging Dynu record's target (VPS IP → Bunny CDN host). `wfe-staging.container`, `/etc/wfe/staging.env`, `/srv/wfe/staging` + mount, and the Caddy staging site block are untouched and keep running. The hostname is unchanged, so `BASE_URL` and the GitHub OAuth callback are stable across the switch.
- *Why:* minimal blast radius; instant, warm rollback (flip the record back, apply — the VPS app is already serving current `:main`).
- *Alternatives:* (a) park Bunny on `*.b-cdn.net` with a throwaway OAuth app — rejected: more setup, and a different hostname contaminates the OAuth/`BASE_URL` path we want to exercise. (b) decommission VPS staging — rejected: destroys the fallback for no benefit during a spike.

### D2 — CDN endpoint, not Anycast
Use a CDN endpoint for managed HTTPS (the staging replacement for Caddy's TLS termination), and because evaluating the CDN edge is itself something we want to feel for a possible prod path.
- *Trade-off:* at one replica in one region, the CDN's edge-cache value for *dynamic* content is ~nil (every dynamic request still reaches Frankfurt); CDN is essentially buying managed TLS while adding a caching surface Anycast lacks. Accepted because managed TLS + edge evaluation is the point.
- *Alternative:* Anycast (L4, no cache surface) — kept as the documented fallback if the cache observation (D3) shows a leak.

### D3 — Deploy on CDN defaults; verify caching by observation, react only if needed
No pre-built edge rules. Deploy, then `curl -D-` a dynamic route twice (two sessions) and inspect `cdn-cache` / `Cache-Control` / `age`. Expectation: Bunny respects origin headers → `/static/*` cached, dynamic uncached, zero config. Only if dynamic routes are cached do we add an edge rule (cache-time 0 except `/static/*`) or fall back to Anycast (D2).
- *Why:* building a guard before observing the default is exactly the "design around an unknown failure mode" anti-pattern we're avoiding. The blast radius while observing is negligible (staging, demo data, a couple of test logins).
- *Boundary:* this is a **gating observation** before the same shape is ever proposed for prod — a dynamic-route cache hit is a cross-owner leak (`SECURITY.md §4`). Cheap to find out on staging; not acceptable to ship to prod unverified.

### D4 — Secrets as plaintext env vars (no platform secret store)
Magic Containers has no secret store; the `bunnynet` `env` block is plaintext `{name,value}`. Staging OAuth client id/secret and `AUTH_ALLOW_STAGING` flow `TF_VAR_*` → encrypted tofu state → Bunny env. Values never land in committed tfvars.
- *Why:* same trust model as the VPS env files today (state is AES-GCM encrypted at rest).
- **Provider pitfall (must handle):** the provider does **not** mark `env.value` as `Sensitive`, so it renders **unredacted in plan output** — and `plan-infra.yml` pipes the plan into `$GITHUB_STEP_SUMMARY`, which would leak the staging OAuth secret into PR CI. *Mitigation:* declare every secret-bearing `TF_VAR_*` input as `sensitive = true`; Terraform then redacts them as `(sensitive value)` in plan output regardless of the resource schema. State encryption (already on) covers at-rest; the `sensitive` var covers the plan-render leak.

### D5 — Deploy by PATCHing the new image digest; TF ignores the image fields
**Resolved against Bunny docs:** the *only* documented rolling-update trigger is "updating the container image" — a `/deploy` or `/restart` call does NOT re-pull. So a tag-stable rollout (keep `:main`, poke a rollout endpoint) is not viable; the reliable, repeatable trigger is a **changing image digest** per deploy.
- `deploy-staging.yml` builds/pushes `:main` and captures the pushed digest (`docker-build` exposes a `digest` output), resolves the app id by name (robust to recreation), then rolls the app via the official **`BunnyWay/actions/container-update-image` action — pinned to a commit SHA** (`…@671d620…` = `container-update-image@0.2.2`), passing `image_tag: main` + `image_digest: <new>`. The action source was verified to send both in the PATCH (no digest stripping), so the changing digest triggers the rollout. SHA-pinning (not `@main`) neutralizes the supply-chain risk of handing `BUNNYNET_API_KEY` to a third-party action. Then it polls the Bunny-served `/readyz` for `gitSha` convergence (no rollout-status API exists; polling the public URL is the only signal). *(The equivalent inline-curl PATCH works too and is dependency-free, but the official SHA-pinned action is fewer lines and source-verified.)*
- **Drift control:** because CI mutates the image digest out-of-band and the provider manages those as attributes, the app resource declares `lifecycle { ignore_changes = [container[0].image_tag, container[0].image_digest] }`. TF stops managing the image; CI owns it. This keeps the `plan-infra` empty-plan gate green after every deploy. `image_tag` stays `"main"` in config as the floor; `image_pull_policy = "Always"`.
- *Verification:* the first push to `main` after this lands is the test (§5.2) — if `/readyz` never converges, the PATCH body or endpoint needs adjustment (fails loud; running staging is unaffected). Also confirms there's no residual digest drift in the next `plan-infra`.

### D6 — Observe memory, don't wire it
No DuckDB `memory_limit`. Add only a read-only smoke probe (`/proc/meminfo` MemTotal, `/sys/fs/cgroup/memory.max`, `nproc`, DuckDB `current_setting('memory_limit')`) to learn what the container advertises. `current_setting` answers it in one shot regardless of load.
- *Why:* deferred by decision; the spike is the cheap place to gather the data that would justify (or not) a future fix. See the migration memory's verification #3.

### D7 — Provider-specific HCL constraints (from provider research)
Pin `BunnyWay/bunnynet ~> 0.15` (0.x with frequent breaking minors — read the CHANGELOG on every bump; min TF 1.11, we're aligned). Concrete shape constraints to encode from day one:
- **Public image registry is a numeric ID via a data source, not creds:** `data "bunnynet_compute_container_imageregistry" { registry = "GitHub", username = "" }` (empty username = built-in public registry) → use its `.id` for `container.image_registry`. No token; a registry *resource* is only for private images. `image_name` carries no domain (e.g. `stefanhoelzl/workflow-engine` split into `image_namespace`/`image_name`).
- **Block ordering:** `container`, `endpoint`, and `env` blocks MUST be alphabetized by `name` in the `.tf` source (list-typed since 0.11.0) or every apply shows spurious "modified" diffs.
- **Region:** Frankfurt = `"DE"` in `regions_required`. Validate via the `bunnynet_region` data source.
- **Custom hostname is a separate resource:** the CDN `endpoint` block exposes a read-only `cdn.pullzone_id`; attach the hostname via `bunnynet_pullzone_hostname { pullzone = <pullzone_id>, name = "staging...", tls_enabled = true, force_ssl = true }`. Read the `*.b-cdn.net` CNAME target via a `data "bunnynet_pullzone"` lookup by that id (confirm the data source resolves an app-owned pull zone; else read from dashboard). Set `cdn.origin_ssl = false` (edge→container plaintext, as Caddy→app today) and let Bunny own the HTTP→HTTPS redirect so there's no redirect loop.
- **TLS issuance is async + DNS-gated:** Terraform requests the managed Let's Encrypt cert but cannot await validation, which only succeeds once the CNAME points at Bunny. Apply ordering is hostname → flip CNAME → wait → cert issues; verify out-of-band. Avoid thrashing applies (LE rate-limit lockout ~1 week).
- **Don't rename the CDN endpoint post-cutover:** renaming a `type=CDN` endpoint can recreate the pull zone, orphaning the hostname + cert and forcing re-validation.

## Risks / Trade-offs

- **Volume comes up empty after a reschedule/redeploy** (Bunny: no backups, reattach not guaranteed) → *Mitigation:* none by design. Accept-loss; staging data is low-stakes and `deploy-staging.yml` re-uploads demo bundles each deploy. If it bites, that's a finding, not an incident.
- **Rolling update under `min=max=1` with a node-bound volume may cause brief downtime or an empty volume** → *Mitigation:* none pre-built; observe how Bunny sequences it. VPS fallback covers any staging outage.
- **CDN caches a dynamic response** (cross-owner leak class) → *Mitigation:* the D3 curl observation catches it on staging before prod is ever considered; edge-rule or Anycall fallback if seen.
- **TLS re-validation churn when flipping the record back to the VPS** (Caddy re-runs ACME) → *Mitigation:* none needed; port 80 stays open on the VPS, Caddy re-issues automatically. Seconds of churn, no manual work.
- **`bunnynet` provider schema gaps** (e.g. an attribute we need isn't exposed) → *Mitigation:* the first task is a thin apply that proves app+volume+endpoint+env+probe converge; fill gaps via API/click-ops and document.
- **Plaintext env at the platform** → *Mitigation:* keep values out of committed tfvars; encrypted in state as today. No `Authorization`/cookie/secret logging changes.

## Migration Plan

1. Add `bunnynet` provider + `BUNNYNET_API_KEY`; thin-apply the staging app (volume, CDN endpoint, env, `/readyz` probe, `min=max=1`, Frankfurt) on the Bunny-default `*.b-cdn.net` host first.
2. Attach `staging.workflow-engine.webredirect.org` as a custom hostname on the CDN endpoint; confirm Bunny issues its cert.
3. Observe: CDN cache curl check (D3), memory probe (D6), `/readyz`, OAuth login on the b-cdn.net host.
4. Re-target the staging Dynu record → Bunny CDN host. Confirm OAuth round-trip on the real hostname.
5. Extend `deploy-staging.yml` with the Bunny rolling-update + `/readyz`-poll step.
- **Rollback:** hand-edit the staging Dynu record back to the VPS IP + apply. VPS staging is still live on current `:main`. Cert re-issues automatically.

## Open Questions

- Bunny's CDN default caching behavior for a 200 with no `Cache-Control` — discovered by D3, not assumed.
- How Bunny sequences a rolling update under `min=max=1` with a bound volume (same-node reattach vs reschedule) — discovered by watching deploys, not pre-solved.
- What `/sys/fs/cgroup/memory.max` reports and what DuckDB auto-detects — discovered by D6.
- Whether the `bunnynet` provider exposes everything we need or some config needs click-ops/API — discovered by the thin apply.
