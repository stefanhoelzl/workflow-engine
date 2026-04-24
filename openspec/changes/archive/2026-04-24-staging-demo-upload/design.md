## Context

Today's pipeline:

```
PR ──► ci.yml: pnpm validate + pnpm -r build + docker-build
                                │
                                └─ workflows/ has no `build` script → bundle build skipped

push main ──► deploy-staging.yml: docker build+push ──► tofu apply
                                                              │
                                                              └─ runtime boots, zero workflows loaded
```

Two gaps:

1. A breaking change to the SDK surface or sandbox-stdlib that regresses `workflows/src/demo.ts` is not caught on PRs. CLAUDE.md "Example workflows" explicitly names `demo.ts` as the canonical surface fixture and requires SDK/stdlib changes to keep it green — but CI doesn't enforce it.
2. Staging runs with an empty workflow registry, so post-merge we have no end-to-end evidence that the executor, event store, dashboard, trigger UI, or sandbox actually work on the freshly-deployed image.

Closing both gaps requires (a) making the bundle build participate in `pnpm -r build`, and (b) uploading `demo.ts` after each staging deploy. Auth against staging is github-OAuth-only; the built-in GITHUB_TOKEN cannot be used because its identity (`github-actions[bot]`) fails `OWNER_REGEX` and is not in `AUTH_ALLOW_STAGING`.

## Goals / Non-Goals

**Goals:**
- PR validation fails when `workflows/src/demo.ts` (or the SDK bundler path it exercises) can no longer be built.
- Every push to `main` results in `demo.ts` being live under `stefanhoelzl/workflow-engine` on the staging runtime immediately after rollout.
- Reuse the existing bundle-build code path (no parallel implementation); `wfe build` and `wfe upload` invoke the same `build()` function.
- Zero app-side auth or security-invariant changes.

**Non-Goals:**
- Uploading demo.ts to prod. Prod remains pristine.
- Alerting on staging demo health. The 5-minute cron is an ambient smoke signal only.
- A generalised "upload any workflow on deploy" mechanism. Only `workflows/` in this monorepo is covered.
- Replacing the PAT with a GitHub App. Accepted risk per interview.
- Segregating demo uploads into a separate `(owner, repo)` like `stefanhoelzl/workflow-engine-demo`. The shared scope is accepted.

## Decisions

### D1: `wfe build` as a new subcommand, not a flag on `wfe upload`

Add `buildCommand` alongside `uploadCommand` in `packages/sdk/src/cli/cli.ts`. It calls `build({ cwd })` from `packages/sdk/src/cli/build.ts` (unchanged) and exits.

**Alternatives considered:**
- `wfe upload --dry-run`: couples two concerns (build vs transmit) on one command; harder to discover; flag surface grows.
- Separate `@workflow-engine/build-cli` package: overkill for 15 lines of code.

**Why this one:** `cli` spec already describes `wfe <subcommand>` grammar; adding `build` fits the existing shape. Shared `build()` function means CI's build gate and deploy-staging's upload cannot diverge.

### D2: Participate in `pnpm -r build` via `workflows/package.json` `build` script

`"build": "wfe build"` in `workflows/package.json`. `pnpm -r build` respects workspace dep order, so `@workflow-engine/sdk` builds first (producing the `wfe` binary), then `workflows` consumes it.

**Alternative:** a dedicated `workflows-build` job in `ci.yml`. Rejected — adds CI surface, slower, and duplicates the dep-order logic pnpm already gives us for free.

### D3: Staging auth via new `GH_UPLOAD_TOKEN` PAT secret

Fine-grained PAT on `stefanhoelzl` (no scopes required — `GET /user` works with any authenticated token). Wired into the upload step as `env.GITHUB_TOKEN`, consumed by `wfe upload` via its existing github-provider code path.

**Alternatives considered:**
- Built-in `GITHUB_TOKEN`: rejected — identity is `github-actions[bot]`, fails `OWNER_REGEX` (`[`/`]` not allowed) and is not in `AUTH_ALLOW_STAGING`. Would require normalizing `[bot]` in the github provider + extending AUTH_ALLOW — touches SECURITY.md §4 identity boundary.
- GitHub App installation token: same `[bot]` suffix problem; heavier setup.

**Accepted risk:** PAT expiry (max 1 year on fine-grained PATs). Mitigation: runbook note in `docs/infrastructure.md`; rotation is manual.

### D4: Readiness probe on `/readyz`, not `/healthz` or a fixed sleep

`tofu apply` returns when K8s reconciles, but the rolling Deployment may still be replacing pods. The Service routes only to ready endpoints; `/readyz` returns 200 only when the runtime reports itself ready (`packages/runtime/src/health.ts:292`). `curl -fsS --retry 30 --retry-delay 5` gives a ~2.5-minute ceiling, which is comfortably above a normal kind/UpCloud rollout.

**Why not `/healthz`:** liveness endpoint; passes earlier than readiness.
**Why not fixed sleep:** flaky under load spikes; wasteful under nominal rollout.

### D5: Scope = `stefanhoelzl/workflow-engine` (auto-detected)

The CLI detects owner/repo from `git remote get-url origin` (`packages/sdk/src/cli/git-remote.ts`). In GitHub Actions the checkout has that remote, so no `--repo` flag is needed. `AUTH_ALLOW_STAGING` already permits `github:user:stefanhoelzl`, and the github provider seeds `orgs` with the user's own login (`github.ts:188`), so `isMember(user=stefanhoelzl, owner=stefanhoelzl)` → true.

### D6: Staging URL from `tofu output -raw url`

`infrastructure/envs/staging/staging.tf:234` already defines `output "url" { value = "https://${var.domain}" }`. Reading it keeps the workflow and infra as a single source of truth, so a domain change in TF vars flows automatically.

### D7: Upload failure = deploy failure

No `continue-on-error`. If the upload fails, the job fails, the commit is marked red in GitHub. Rationale: a missing demo after deploy is a regression; silent failure defeats the point of the smoke signal.

### D8: Sequencing inside `deploy-staging.yml`

```
checkout ──► docker login ──► docker-build (push) ──► setup-opentofu ──► tofu apply ──►
  capture_url (tofu output -raw url) ──► setup-pnpm ──► pnpm install ──►
    readiness probe (curl --retry /readyz) ──► wfe upload (env: GITHUB_TOKEN=GH_UPLOAD_TOKEN)
```

All new steps are post-apply. `setup-pnpm` and `pnpm install` run after `tofu apply` so that a failing apply short-circuits before we spend time installing JS deps.

## Risks / Trade-offs

- **[PAT expiry silently breaks staging deploy]** → Runbook note; rotation cadence calendared by the operator. Accepted.
- **[demo.ts cron produces continuous traffic on staging]** → Intentional; acts as ambient smoke signal. No alerting wired so no pager noise.
- **[Demo bundle overwrites any human-uploaded `stefanhoelzl/workflow-engine` workflow on staging]** → Staging is understood to be demo-scoped; operator must not use this `(owner, repo)` for anything else. Accepted; noted in proposal Impact.
- **[Race between rollout and upload]** → `/readyz` on the Service only answers 200 from ready endpoints; bundle writes land in S2 (shared persistence), so even if the probe hits the old pod momentarily, the new pod loads from the same backing store on boot.
- **[`pnpm -r build` runs `wfe build` before SDK is built?]** → Not a risk — pnpm topologically orders workspace builds; SDK is a dependency of `workflows`, so SDK's `tsc --build` completes before `workflows/build` runs. If dependency metadata ever drifts, `pnpm -r build` fails loudly before any wfe invocation.
- **[First deploy on a fresh staging hits TLS errors because cert-manager hasn't issued]** → Out of steady-state operation; noted in runbook but not mitigated by retries in the workflow.
