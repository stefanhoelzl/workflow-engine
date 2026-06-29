## Context

Staging already runs entirely on bunny.net (Magic Containers app `:main`, Bunny
Database for the event-store/queues, Bunny Edge Storage for bundles, Bunny CDN
for managed TLS). The four staging changes that got it there are archived
(`staging-bunny-magic-containers`, `bunny-bundle-storage-staging`,
`cutover-staging-bunny-database`, `remove-vps-staging`). As a result the
Scaleway VPS now hosts **only** `wfe-prod` + `caddy` — so "retire the VPS
completely" is the same operation as "move prod onto Bunny."

Every seam prod needs is already built and **proven in production-shaped use on
staging**:

- `STORAGE_BACKEND=bunny` + `STORAGE_BUNNY_*` (Bunny Edge Storage backend).
- Remote libSQL via `DATABASE_URL=libsql://…` + `DATABASE_AUTH_TOKEN` (token
  present ⇒ remote client variant; `DATABASE_WAL` must be absent).
- The `bunnynet` provider app/CDN/storage-zone/database shapes and the in-tofu
  token mint (`magodo/restful` `restful_operation`).

So this change needs **no runtime, SDK, or `demo.ts` code** — it is infra +
data migration + CI + docs. `docs/infrastructure.md` already anticipates it
("Flipping prod to a remote Bunny Database (future cutover)" + the pre-prod
checklist).

**What makes prod different from staging:** staging was accept-loss with
auto-re-uploaded demo bundles. Prod has **real data and real external authors**
(`AUTH_ALLOW` = `stefanhoelzl`, `mrh1997`, `baltech-ag`, `sharepad-de`) whose
bundles are uploaded by hand and never re-uploaded automatically, and whose
workflow secrets are sealed against prod's existing sealing key. Preserving
those bundles and that key is the central constraint of this change.

**Footprint, measured.** Over SSH (`deploy@163.172.161.96`, the prod A record),
`df /srv/wfe/prod` reports **~1.5 MB used** on the whole prod data volume —
`events.db` + every author bundle combined. (The directory itself is owned by
the rootless container's subuid, so a per-file `ls` isn't readable as `deploy`
without a password; `df` is filesystem-level truth.) Consequence: Bunny's
1 GB/DB cap has ~600× headroom and the bundle copy is seconds. The data size is
**not** a constraint on anything here; the maintenance window is dominated by
app stop/start + DNS propagation + Bunny ACME, not the copy.

## Goals / Non-Goals

**Goals:**
- Prod's app, event-store/queues, bundles, and TLS all run on Bunny; the
  Scaleway VPS and its supporting tofu are gone at the end of this one change.
- **Zero author-visible disruption:** existing sealed workflow secrets keep
  decrypting and existing bundles keep serving with no author action — i.e. the
  prod sealing key value is preserved and bundles are copied across.
- Prod invocation history is migrated (pruned to the 90-day retention window).
- The cutover has a **verify-before-destroy** point and **no cert-issuance
  downtime gap** — only the deliberate maintenance window is downtime.
- The remaining tofu describes both Bunny envs through one env-keyed shape, with
  no VPS machinery left behind.

**Non-Goals:**
- A warm-fallback period or a separate teardown change (big-bang: one change).
- Off-box backups / snapshots for the Bunny Database or bundle zone (status
  quo: none today either; stays a tracked follow-up).
- Read-path retry for cold-start reads (accept retry-on-failure, as staging).
- New explicit pre-cutover verification tasks gating the apply (staging is
  treated as sufficient proof of the seams).
- Moving the tofu **state** off Scaleway Object Storage.
- Any runtime/SDK/`demo.ts`/sandbox/manifest change.

## Decisions

### D1 — Big-bang: retire the VPS in this same change
The VPS hosts only prod; there is nothing left to keep it for once prod is on
Bunny. So the same change that cuts prod over also deletes the entire VPS
tofu (instance, IP, security group, prod block volume, Caddy, `host.tf`,
`apps.tf`, `caddy.tf`, `cloud-init.yaml`, the `scaleway` provider's compute
usage). **Rejected:** a "cutover now, retire later" two-change sequence with a
warm-fallback observation window (the staging-spike pattern) — unnecessary here
because the platform is already proven by the live staging deployment; a warm
prod VPS would just be idle cost and a second change to land.

### D2 — Choreographed apply (verify-then-destroy), not one atomic apply
"Big-bang" (D1) constrains the *change*, not the *apply mechanics*. The operator
runs the cutover as **three applies in one session**, within this one change:

```
apply #1  create the prod Bunny stack (app :release, Database+token, Edge
          Storage zone, CDN) + the env-keyed module refactor.  VPS UNTOUCHED,
          still serving prod on its A record.
          → curl the raw Bunny CDN host, confirm /livez green.

[window]  operator maintenance window (non-tofu):
          • stop wfe-prod on the VPS  → writes quiesced (consistent dump point)
          • dump events.db pruned to 90d → restore into the prod Bunny Database
          • rsync the workflows/ bundle tree → prod Edge Storage zone
          • verify reads/writes against the Bunny CDN host directly

apply #2  flip DNS workflow-engine.stho.net  A(VPS IP) → CNAME(Bunny CDN host);
          wait for propagation + Bunny managed-TLS issuance. Prod now live on
          Bunny, verified, cert issued.

apply #3  destroy the VPS resources (instance, IP, SG, prod block volume after
          lifting prevent_destroy, tls key, null_resource convergence). The
          scaleway/null/tls PROVIDERS stay declared (needed to destroy these);
          a fast-follow drops them once state is clean (D9).
```

**Why:** an atomic destroy+create gives no point to confirm Bunny prod healthy
before the VPS is gone, and tears the VPS down *before* the DNS/ACME cert has
issued → prod hard-down for the propagation+ACME window. Choreographing costs
only two extra `apply` invocations in the same session and still satisfies D1
(VPS gone same change, no warm period; the two stacks coexist for ~minutes and
never both serve traffic, never share a DB). This mirrors the staging custom-
hostname **two-step targeted apply** (DNS first, then full apply) already
documented in `bunny-staging.tf`. **Rejected:** single `tofu apply` that
destroys the VPS and creates the Bunny stack together (accept cert-gap downtime
+ no verify point) — saves two invocations, buys real risk on a one-way move.

### D3 — Generalize `bunny-staging.tf` into one env-keyed Bunny config
After the VPS tofu is deleted, `local.envs`/`apps.tf`/`host.tf`/`caddy.tf` and
most of `main.tf` are gone and **both** envs run on Bunny. Refactor the staging
Bunny resources into a single env-keyed shape (`for_each`/locals over
`{ staging = {…:main…}, prod = {…:release…} }`) producing per-env app, CDN,
Database, token, storage zone, sealing key, and pullzone-hostname. **Why:** the
end state is two near-identical Bunny stacks; an env-keyed module is the honest
shape and avoids copy-paste drift. **Rejected:** a parallel `bunny-prod.tf`
copied-and-adapted from `bunny-staging.tf` — smaller blast radius and easier to
diff against the proven file, but leaves two divergent copies to maintain; we
accept the larger refactor because it lands with `moved {}` no-op guards (D4)
and the staging half is unchanged behaviourally.

**Spec mirrors the module.** Because the code becomes one env-keyed module for
both envs, the **`bunny-staging` capability is renamed to `bunny-deployment`**
and its requirements are re-parameterized over `{ staging, prod }` (resource
addresses become env-keyed, the literal `staging.*` hostname becomes
`base_domain`-composed per env, and the "CDN SHALL NOT cache dynamic routes
(gating observation) — before this is proposed for prod…" requirement is
resolved now that prod *is* this capability). The rename is the fiddliest spec
delta in the change (REMOVE-from-`bunny-staging` + ADD-to-`bunny-deployment`,
plus cross-ref updates), but it rides alongside the already-heavy capability-map
edit (`reverse-proxy` and `host-security-baseline` are removed/gutted with the
VPS), and a capability literally named `bunny-staging` that contains prod
requirements would be a permanent misnomer. **Rejected:** keep the
`bunny-staging` name and merely broaden its scope (smaller delta, no dir rename)
— rejected for the misleading name.

### D4 — Preserve EVERY existing resource value across the refactor via `moved {}`
The refactor changes resource **addresses** for both envs. Each must carry a
`moved {}` block so tofu **moves** state rather than destroy+create:

- **`random_bytes.secrets_key["prod"]` → the prod module sealing key.** This is
  the single highest-blast-radius line in the change. If this move is wrong or
  missing, tofu generates a *fresh* key → every sealed tenant secret
  (`baltech-ag`, `sharepad-de`, `mrh1997`, `stefanhoelzl`) becomes
  undecryptable until that author re-uploads. **Guard:** the `apply #1` plan
  MUST show this as a move (no destroy/create of any `random_bytes`), and the
  rendered `SECRETS_PRIVATE_KEYS=v1:<base64>` for prod MUST be byte-identical
  pre/post (diff the planned env).
- Staging's existing `random_bytes.staging_secrets_key`, `bunnynet_database`,
  `restful_operation` token, `bunnynet_storage_zone`, app, CDN, and
  `bunnynet_pullzone_hostname` likewise get `moved {}` blocks so staging does
  **not** churn (no new staging token mint, no staging sealing-key
  regeneration, no staging DB replacement). Staging is accept-loss so churn
  would be *survivable*, but a no-op refactor is the correct bar.

**Why:** preserving the prod key is a hard goal (zero author disruption);
preserving staging is hygiene. **Rejected:** accept a fresh prod key + ask all
authors to re-upload — contradicts the "copy + preserve key" decision and
breaks live workflows until every external author acts.

### D5 — Bundles: copy across, authors do nothing
In the maintenance window, `rsync` the prod `workflows/<owner>/<repo>.tar.gz`
tree from `/srv/wfe/prod/workflows/` into the prod Bunny Edge Storage zone
(origin host `storage.bunnycdn.com`, never a CDN pull zone, so `recover()`
never sees a stale bundle). Combined with the preserved sealing key (D4), every
existing workflow keeps serving with sealed secrets intact and **no author
re-upload**. **Why:** prod authors don't auto-re-upload (unlike staging's demo
bundles). **Rejected:** clean-break re-upload — coordination burden on external
authors + live breakage.

### D6 — Event data: migrate, pruned to the 90-day window, from a consistent dump
Stop `wfe-prod` first (quiesce writes → consistent snapshot), then dump
`events.db` filtered to the `EVENT_STORE_RETENTION_DAYS=90` window and restore
into the prod Bunny Database via `@libsql/client`. **The migration is run as
documented operator commands in `tasks.md`, not a committed script** (D12) — a
one-shot with no in-repo artifact to maintain or clean up. **Why:** the runtime
self-prunes to 90d on its first tick anyway, so
migrating older rows is wasted; a consistent dump (writes stopped) loses
nothing within the window. The 1.5 MB measured footprint means this is seconds
and nowhere near the 1 GB cap. **Rejected:** full-history copy (no benefit;
trimmed on first prune anyway) and live-while-running dump (would silently drop
the tail of events written during the copy).

### D7 — Separate per-env Bunny resources; never share staging's
Prod gets its **own** `bunnynet_database`, minted token, Edge Storage zone,
sealing key, and OAuth app/vars — distinct from staging's. **Why:** Bunny's
`…/auth/revoke` is **database-wide**, so a shared token would couple the two
envs' availability; a shared storage zone or sealing key would cross-wire prod
and staging data. Prod's OAuth callback is unchanged (`workflow-engine.stho.net`
is unchanged), so the existing prod GitHub OAuth app + `*_PROD` vars carry over
untouched.

### D8 — Deploy path: keep the release-branch gate; roll the Bunny app
`deploy-prod.yml` (push to `release`, gated `environment: production`,
required reviewer) stops being a "build + push, VPS auto-pulls" flow and becomes
the staging-shaped roll: build/push `:release`, capture the digest, roll the
prod Bunny app via the SHA-pinned `BunnyWay/actions/container-update-image`
(or the inline `curl` PATCH equivalent), then poll `/readyz` for `gitSha`
convergence. The prod Bunny app's `readiness_probe` targets **`/livez`**, not
`/readyz` (the staging deadlock lesson: `/readyz` self-reaches `BASE_URL` which
serves 503 during deploy → never goes ready). The prod app declares the same
`lifecycle { ignore_changes = [image_tag, image_digest, image_pull_policy] }`
so CI-driven digest rolls don't fight the `plan-infra` empty-plan gate.
**Why:** keep prod a deliberate, reviewed promotion separate from staging
(`:main`). **Rejected:** collapse prod to deploy from `main` — every merge ships
to prod, no promotion gate.

### D9 — Keep tofu state on Scaleway Object Storage; drop only Scaleway compute
The S3 state backend uses AWS-style creds against the Scaleway Object Storage
endpoint and is independent of the `scaleway` provider (which only models the
VPS compute/IP/SG/volume). So this change removes all the Scaleway **compute
resources** but leaves the encrypted state bucket as-is. **Why:** the state
backend isn't the VPS; it's cheap, working, and AES-GCM-encrypted — migrating it
adds a state-move step and risk for no benefit in scope.

**Provider-for-destroy constraint (load-bearing).** OpenTofu requires a
resource's provider to be present in configuration to *destroy* it. The VPS
resources (`scaleway_*`, `tls_private_key.deploy`, `null_resource.*`) remain in
state until the teardown apply destroys them — so the `scaleway`, `null`, and
`tls` providers (and the `scaleway` provider's creds/vars) MUST stay declared
through that apply. They are dropped in a **fast-follow** change once
`tofu state list` shows none of those resources remain (an empty-plan no-op).
Removing the providers in the same change would make the teardown apply fail
with "Provider configuration not present." **Rejected:** `tofu state rm` the
resources to avoid keeping the providers — that orphans the real VPS (leaves it
running, billed, unmanaged) instead of destroying it. **Rejected:** migrate
state off Scaleway and fully exit — out of scope; a later change.

### D10 — Accept the preview posture for prod (no new mitigations)
No off-box backups, no read-path retry, no new verification-gate tasks. Prod's
data will sit on a single no-backup public-preview Bunny Database; the first
read after an idle spin-down can surface as a failed query the user retries;
the seams are trusted on staging's evidence. **Why:** matches the explicitly
chosen posture; the VPS block volume also had no backups, so backups are not a
regression. Each item stays a documented, tracked follow-up. **Rejected:**
build backups + read-path retry first — defers the cutover for work the operator
chose to accept-risk on now.

### D11 — Rename the `plan (vps)` gate to `plan (infra)`
`plan-infra.yml`'s single job `plan (vps)` is the required status check in the
`main` branch ruleset. With the VPS gone the name is wrong; rename to
`plan (infra)`. **Operator/admin action:** the branch-ruleset required-check
name must be updated in lockstep (a renamed check that the ruleset still
requires under the old name blocks all merges). Surface this in the PR summary;
agents don't edit the ruleset.

### D12 — Migration is throwaway operator commands, not a committed script
The one-time data migration (bundle PUTs + the 90d event-DB row copy) is
documented as a sequence of operator commands in `tasks.md`, not a committed
Node/TS artifact. The two operations:

- **Bundles:** for each `/srv/wfe/prod/workflows/<owner>/<repo>.tar.gz`, an
  authenticated HTTP `PUT` to the prod Edge Storage origin
  (`storage.bunnycdn.com`, the zone's access key) — a `curl` loop, not rsync
  (Bunny Edge Storage is an HTTP API). Byte-identical copy; the preserved
  sealing key (D4) keeps the sealed secrets inside decryptable.
- **Event DB:** dump `events.db` rows within the 90d window and replay into the
  remote Bunny Database via `@libsql/client` (run ad hoc from the monorepo with
  the hoisted client; the embedded file + bundles are pulled off the VPS first,
  since both are owned by the rootless container subuid).

**Why:** a one-shot with no rollback should still be *rehearsed on staging
first* (run the same commands into a throwaway Bunny DB, check row counts +
`recover()`), but it does **not** warrant a permanent in-repo artifact to
maintain or a fast-follow PR to delete. **Rejected:** (a) a committed script in
the change folder (reviewable + auto-archived, but more ceremony than a one-shot
needs); (b) a permanent `infrastructure/scripts/` script (dead code after
cutover; this repo avoids cruft).

## Risks / Trade-offs

- **Sealing-key regeneration (catastrophic if it happens)** → mitigated by the
  D4 `moved {}` block + the explicit plan/byte-identical-env guard before
  `apply #1` proceeds. This is the one line to get right.
- **One-way cutover, no rollback** → accepted (D1). The choreography (D2) adds a
  verify-before-destroy point so a *failed bring-up* is caught before the VPS
  dies; once the VPS is destroyed it's fix-forward only.
- **Prod data on a single no-backup preview DB; 1 GB cap; DB-wide token revoke**
  → accepted (D10); the cap is ~600× oversized for the measured 1.5 MB; revoke
  is safe while prod is the DB's sole consumer (D7 keeps it sole).
- **Cold-start failed-read after idle** → accepted (D10); user/browser retry.
- **Maintenance-window downtime** → the deliberate cost of a consistent dump
  (D6); seconds of copy + minutes of DNS/ACME, not a cert *gap* (D2 issues the
  cert before the VPS dies).
- **Larger refactor (D3) landing with the cutover** → mitigated by D4 making the
  staging half a state-move no-op; the `plan-infra` empty-plan gate plus the
  byte-identical-env check catch unintended churn.
- **CDN caching of authenticated routes (cross-owner leak)** → same app +
  headers as staging, where it's observed clean (only `/static/*` cached);
  carried over under the "staging is proof" decision (D10).
- **Ruleset/required-check rename race (D11)** → a brief window where merges are
  blocked if the check rename and ruleset update aren't in lockstep; operator
  coordinates.

## Migration Plan (operator runbook)

Agents write the tofu (env-keyed module + `moved {}` blocks + VPS deletion +
`prevent_destroy` lift), the one-time migration script, the CI changes, the
docs rewrite, and the openspec artifacts. Agents do **not** run `tofu apply` or
touch prod data. The operator runs:

1. **Pre-flight.** On the feature branch, run `tofu plan` and confirm: the only
   destroys are VPS resources; **no `random_bytes` is destroyed/created**
   (prod + staging keys both show `moved`); the rendered prod
   `SECRETS_PRIVATE_KEYS` is byte-identical to today.
2. **apply #1** — create the prod Bunny stack + apply the module refactor; VPS
   untouched. Curl the raw Bunny CDN host → `/livez` green; confirm the prod
   Database + token + storage zone exist.
3. **Maintenance window** — `systemctl --user stop wfe-prod` on the VPS; run the
   documented migration commands (D12: HTTP `PUT` each `workflows/` bundle to
   the prod Edge Storage origin; dump `events.db` pruned to 90d → replay into
   the prod Bunny Database via `@libsql/client`); verify reads/writes and a
   `recover()` against the Bunny CDN host directly. Rehearse these same commands
   against staging beforehand.
4. **apply #2** (targeted, DNS first) — flip `workflow-engine` A→CNAME; wait for
   propagation + managed-TLS issuance; confirm prod live on Bunny over its real
   hostname (OAuth round-trip, an authenticated route, a trigger).
5. **apply #3** — full apply destroys the VPS resources (instance, IP, SG, prod
   block volume, tls key, `null_resource` convergence). The `scaleway`/`null`/`tls`
   providers stay declared (needed to destroy these). Confirm an empty `plan-infra`.
6. **Ruleset** — rename the required check `plan (vps)` → `plan (infra)` (D11).
7. **Fast-follow** — once `tofu state list` is clean, drop the `scaleway`/`null`/`tls`
   providers + Scaleway vars/creds (empty-plan no-op; D9).
8. Update `docs/infrastructure.md` to the all-Bunny topology (done in-change).

**Rollback reality:** before `apply #3`, rollback is "flip DNS back to the VPS
IP" (the VPS still exists and still has its data). After `apply #3`, there is no
rollback — fix-forward only.
