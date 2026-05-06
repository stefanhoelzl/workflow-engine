## Context

The workflow engine ships a CLI (`wfe`) and an SDK (`@workflow-engine/sdk`) for authoring workflows. Today both are workspace-only: authors must clone the monorepo and run `pnpm exec wfe upload`. This is the only blocker to letting external authors (e.g. a GitHub-org member with no checkout) push workflows to a hosted instance — the auth model (`AUTH_ALLOW` + `isMember(user, owner)` against GitHub orgs) and the upload endpoint already accept any authenticated client.

The branch `npm-deploy` exists to make the SDK installable from npm. The `@workflow-engine` npm org is claimed. The SDK no longer depends on `@workflow-engine/sandbox` (the sdk-support entrypoint that previously imported it is consumed by the runtime via a workspace-relative path, not via the package name).

`@workflow-engine/core` is currently `"private": true` and has `exports` pointing at `./src/*.ts`. The same shape exists in `@workflow-engine/sdk`. Neither package can be installed via npm in its current form: TypeScript source is shipped, peer-of-monorepo workspace deps are unresolved, and `wfe` would not be on `PATH` of an external project.

## Goals / Non-Goals

**Goals:**
- External authors install `@workflow-engine/sdk` via npm and run `npx wfe upload` against a hosted instance. The two operations needed are install and upload.
- A bundle that an old server doesn't understand fails loudly at upload, not silently at runtime.
- The published artifacts are exercised on every PR before they can possibly land on npm.
- No human types a version number. Forgetting to bump is structurally impossible.
- Publish couples to the existing prod-deploy event (push to `release`), so npm and prod can't drift in time.
- No long-lived npm credential exists in CI or repo secrets after bootstrap. Authentication is OIDC-based and pinned to a specific workflow path, branch, and environment.

**Non-Goals:**
- Self-serve signup, multi-tenant SaaS posture, or per-tenant runtime quotas. Tenancy stays GitHub-org-membership.
- Browser-based authoring or a `wfe init` scaffolder. The minimum project is `package.json` + `src/workflow.ts`; documenting that is enough.
- Runtime-semantics forward compatibility (e.g. sandbox-stdlib behavior changes between server versions). The manifest schema can't see these; mitigated by discipline, not this change.
- Independent versioning of sdk vs core, or SemVer compatibility signaling. Both intentionally rejected.
- Bundling `@workflow-engine/core` into the SDK tarball. Intentionally rejected — see Decision 1.
- Author-facing README in the SDK package. Intentionally out of scope for v1.

## Decisions

### Decision 1: Publish `@workflow-engine/core` as a sibling, not bundled

`@workflow-engine/sdk` depends on `@workflow-engine/core` for `ManifestSchema`, `z`, identifier regexes, and `secrets-crypto`. Two options:

- **A. Sibling publish.** Both packages on npm. SDK's `package.json` lists `@workflow-engine/core: "<concrete-version>"`. `tsc --build` is sufficient.
- **B. Bundle core into SDK dist.** Single tarball. Requires a bundler (tsup/rollup) and packaging the `libsodium-wrappers` WASM blob alongside. Sodium loads its WASM async — bundlers either inline the wrapper and ship the `.wasm` as a separate asset (annoying), or pull it via base64 (fat).

**Choice: A.** The libsodium overhead in B is real, the gain (one published name instead of two) is cosmetic, and core's surface remains effectively private because nothing in author docs points at it. Core's `package.json` `description` is left as-is; no "do not import directly" warning.

The runtime continues to import `core` via `workspace:*`. The published-form audit lives in CI (Decision 5).

### Decision 2: Make `ManifestSchema` `.strict()` (and recursively on nested object schemas)

`z.object()` in Zod v4 defaults to **strip** — unknown keys are silently dropped. Today this means a new SDK that adds a manifest field can upload to an old server and the field is silently lost. The author sees no error and assumes their feature works.

**Choice: strict.** Apply `.strict()` to `ManifestSchema` and to every `z.object(...)` subschema (`workflowManifestSchema`, `actionManifestSchema`, `httpTriggerManifestSchema`, `cronTriggerManifestSchema`, `manualTriggerManifestSchema`, `imapTriggerManifestSchema`, `wsTriggerManifestSchema`, `queueManifestSchema`, and any nested `z.object` within them). Discriminated unions inherit their variants' strictness.

**Implication captured here so future-you doesn't relearn it:** every new manifest field is now a server-first deploy. SDK cannot ship a field until the running server's `ManifestSchema` accepts it. This is a coordination cost paid once per field, in exchange for no silent strips ever. Worth it.

The HTTP trigger subschema already enumerates explicit forbidden top-level fields; making the schema strict makes that enumeration redundant, but the explicit form is preserved for clarity of error messages — strict mode rejects with `"Unrecognized key"`, the explicit form gives a more specific error. Both layers stand.

### Decision 3: CalVer (`YYYY.MM.PATCH`), lockstep core+sdk, auto-bump on source change

SemVer's compatibility signaling is fictional under Decision 2 — every additive manifest change is a breaking change for old servers. CalVer makes that honest.

**Scheme:** `YYYY.M.PATCH`, e.g. `2026.5.0`, `2026.5.1`, `2026.6.0`. No zero-padding (`2026.5.0`, not `2026.05.0`) — semver-comparable as numeric segments.

**Bump rule (CI shell):**
```bash
LAST=$(npm view @workflow-engine/sdk version 2>/dev/null || echo 0.0.0)
NOW="$(date -u +%Y.%-m)"
case "$LAST" in
  $NOW.*) NEXT="$NOW.$((${LAST##*.}+1))" ;;
  *)      NEXT="$NOW.0" ;;
esac
```

**Lockstep:** core and sdk publish with the same version, every time. If only one changed, the other publishes too. No version-coordination judgment per PR.

**Source-of-truth for version:** `package.json` `"version"` is permanently `"0.0.0-dev"`. CI rewrites it at publish time only and does not commit the change back. The committed value is never the real version; npm has truth.

**Source-change gate (mandatory, see Decision 4):** publish only runs when `git diff --name-only $LAST_TAG..HEAD -- packages/sdk packages/core` is non-empty. Without this gate, every prod deploy would publish a no-op patch bump.

**Git tags:** after a successful publish, CI tags the commit `v$NEXT` and pushes the tag. The tag is the diff anchor and the npm-↔-git reconciliation point.

### Decision 4: Publish wired into the existing prod-deploy event, authenticated via npm trusted publishing (OIDC)

Adding the publish step to `.github/workflows/deploy-prod.yml` (push to `release`, gated by `environment: production`) keeps npm and prod tied to the same human action. Author-side and operator-side updates land in the same release.

**Auth: npm trusted publishing (OIDC), not a long-lived token.** The npmjs.com trusted-publisher config for each of `@workflow-engine/sdk` and `@workflow-engine/core` pins to:
- Repository: `stefanhoelzl/workflow-engine`
- Workflow file path: `.github/workflows/deploy-prod.yml`
- Branch: `release`
- Environment: `production`

A compromise of repo secrets does not enable npm publishing because no static credential exists. A new workflow file added by a malicious PR cannot publish because it doesn't match the pinned workflow path. Renaming the workflow file or moving the publish to a different branch breaks the binding loudly — that's the *good* kind of brittleness.

**Provenance:** `npm publish --provenance` reuses the same `id-token: write` permission already required for OIDC auth, producing a sigstore-signed attestation linking the package to the GitHub Actions run + commit sha. The package's `package.json` MUST declare a `repository` field matching the GitHub repo URL; provenance validation rejects publishes without it. SDK already does; core needs the field added.

**Why `npm publish` and not `pnpm publish`.** `pnpm/pnpm#9812` is closed with the resolution "pnpm publish passes through to npm CLI under the hood." In practice, multiple reports (including a maintainer-acknowledged comment on that thread) state that `pnpm publish` does not reliably exchange the GitHub OIDC token against npm 11.5.1+ on GitHub-hosted runners — the publish fails authentication while a plain `npm publish` from the same shell with the same env succeeds. We therefore use `pnpm pack` (which correctly rewrites `workspace:*` → concrete version in the produced tarball, the same rewrite `pnpm publish` would do) and `npm publish <tarball>` for the actual publish.

**Bootstrap (one-time per package, before any automated publish).** npm trusted publishing cannot publish a package's first version: the npmjs.com config UI requires the package to exist before the trusted publisher can be bound (npm/cli#8544 unresolved). The bootstrap procedure for each package is:

1. Operator generates a short-lived classic automation token in the npm UI.
2. Locally, with the npm CLI logged in via that token: `npm publish --access public` a `0.0.0-init` placeholder (minimal `package.json`, no real content).
3. On npmjs.com (or via `npm trust github` with npm ≥ 11.10): bind the trusted publisher to the workflow path, branch, and environment listed above.
4. `npm deprecate <pkg>@0.0.0-init "bootstrap placeholder"`.
5. Revoke the classic token.

After step 3, no long-lived credential exists anywhere. The CalVer auto-bump produces `2026.M.0` for the first real publish, which sorts above `0.0.0-init`. The deprecated placeholder remains visible on npm but cannot be installed by tooling.

**Order of operations in the CI publish job:**
1. Checkout (with `fetch-depth: 0` so `git describe` sees tags), setup-node ≥ 22.14, setup-pnpm, ensure npm ≥ 11.5.1.
2. `pnpm install --frozen-lockfile`.
3. `pnpm -r build` (produces `dist/`).
4. Compute `LAST_TAG = $(git describe --tags --match 'v*' --abbrev=0 2>/dev/null || echo "")`.
5. `git diff --name-only $LAST_TAG..HEAD -- packages/sdk packages/core`. Empty → exit 0 (deploy continues, no publish).
6. Compute CalVer (script in Decision 3).
7. Rewrite `version` in `packages/core/package.json` and `packages/sdk/package.json` to `$NEXT` (in-place, not committed back).
8. `pnpm --filter @workflow-engine/core pack` → `workflow-engine-core-$NEXT.tgz`.
9. `pnpm --filter @workflow-engine/sdk pack` → `workflow-engine-sdk-$NEXT.tgz`. `workspace:*` is rewritten to the concrete `$NEXT` because step 7 wrote the same value into core's package.json before packing.
10. `npm publish workflow-engine-core-$NEXT.tgz --access public --provenance`.
11. `npm publish workflow-engine-sdk-$NEXT.tgz --access public --provenance`. Order matters: sdk's tarball references core@$NEXT, so core must already be on the registry.
12. `git tag v$NEXT && git push origin v$NEXT`.

The deploy-prod job's existing image-push + readiness-poll continue unchanged. Publish runs in parallel with (or after) the image push — it's a separate concern.

### Decision 5: PR-time publish-shape smoke test

The workspace's `workflows/` package consumes the SDK via `workspace:*`. Node resolves SDK source through that symlink, bypassing the `exports` map. So a typo in `exports`, a missing file in `dist/`, a leaked `workspace:*` dep, or a wrongly-chmodded `wfe` bin all pass local CI today.

**Test shape (new job in `.github/workflows/ci.yml`):**
1. `pnpm install --frozen-lockfile`, `pnpm -r build`.
2. `cd packages/core && pnpm pack` → `workflow-engine-core-*.tgz`.
3. `cd packages/sdk && pnpm pack` → `workflow-engine-sdk-*.tgz`.
4. `mkdir /tmp/smoke && cd /tmp/smoke && npm init -y`.
5. `npm install <repo>/packages/core/*.tgz <repo>/packages/sdk/*.tgz` — both tarballs together so npm resolves the `@workflow-engine/core` peer from the local file rather than the registry.
6. `mkdir src && cp <repo>/workflows/src/demo.ts src/`.
7. `npx wfe build`. Assert `dist/demo.js` exists and is non-empty.

`pnpm pack` rewrites `workspace:*` → concrete version in the tarball (same rewrite `pnpm publish` would do), so this is the highest-fidelity test possible without a registry round-trip.

**Runs on every PR.** Path-filtering (only on changes to `packages/sdk`, `packages/core`, `workflows/`) was considered and rejected — the failure class this catches is precisely the kind of "looks unrelated, breaks publish shape" change that path filters miss.

### Decision 6: Drop `./sdk-support` from the SDK's published `exports`

The runtime imports `sdk-support` via a workspace-relative path with a Vite query suffix: `import sdkSupportPlugin from "../../sdk/src/sdk-support/index.ts?sandbox-plugin"`. It does not use the `@workflow-engine/sdk/sdk-support` package-name path. Removing the subpath from `exports` therefore breaks no runtime callsite and prevents external authors from accidentally importing what is effectively a private host-side plugin module.

The existing `sdk` spec (`Requirement: SDK provides subpath exports`) lists `.`, `./plugin`, `./cli`. `./sdk-support` was never part of the spec; this decision is an editorial clarification of `package.json` to match the spec.

### Decision 7: PR-time publish dry-run gate

Decision 5's smoke test exercises the *consumer* path (install + build demo). It does not exercise npm's publish-shape validation — `package.json` metadata correctness, files-array completeness, missing required fields for provenance (e.g. `repository`), invalid license identifiers, scoped-package access settings, or any other client-side check npm runs before uploading.

`npm publish --dry-run <tarball>` runs that validation locally without authenticating. It catches publish-shape errors at PR time, before the release-time job has a chance to fail loudly mid-publish.

**Step shape (added to the same smoke-test job as Decision 5):**
```
   pnpm --filter @workflow-engine/core pack
   pnpm --filter @workflow-engine/sdk pack
   npm publish --dry-run workflow-engine-core-*.tgz --access public --provenance
   npm publish --dry-run workflow-engine-sdk-*.tgz  --access public --provenance
```

The dry-run does not exchange OIDC tokens (no real publish happens), so it works on every PR including from forks. `--provenance` in dry-run mode validates the prerequisites without actually signing — it confirms the `repository` field is present and matches, the workflow has `id-token: write`, and the metadata is well-formed.

**Catches what the consumer-side smoke test does not:**

```
   Bug class                                                   Caught by dry-run?
   ─────────                                                   ─────────────────
   Missing `repository` field in core package.json             ✓
   Invalid SPDX license identifier                             ✓
   `files` array referencing a non-existent path               ✓
   `bin` path that the tarball doesn't contain                 ✓
   Scoped package without `--access public` declared           ✓
   Provenance prerequisites missing (id-token perm, etc.)      ✓
```

These would all be silent in the consumer-side smoke test (which only cares that the tarball installs and builds) and would only surface at the release-time publish, which is too late.

## Risks / Trade-offs

- **Risk: an upload from a new SDK to an old server hard-fails on a benign new optional field.** → Mitigated by Decision 2's coordination cost: server-first deploys. The failure is loud (`422 Unprocessable Entity` with the offending key), the author sees it immediately, and the fix is "redeploy the server, then republish the SDK." Acceptable in exchange for no silent strips.

- **Risk: the source-change gate (Decision 4) silently skips a publish when `packages/sdk` and `packages/core` are unchanged but a *transitive* dep of theirs was upgraded** (e.g. a Zod minor bump in `pnpm-lock.yaml`). → Acceptable. Lockfile churn doesn't change the published artifact's behavior in any way authors observe — the published tarball pins its deps to its own `package.json` ranges. If a transitive change does become author-visible, the next intentional source change to sdk/core picks it up.

- **Risk: `npm publish --provenance` fails if `id-token: write` is missing.** → Mitigated by setting `permissions:` block on the publish job explicitly.

- **Risk: pnpm publish does not reliably exchange the GitHub OIDC token against npm 11.5.1+ on GitHub-hosted runners (pnpm/pnpm#9812).** → Mitigated by Decision 4's "use `pnpm pack` + `npm publish <tarball>`" pattern. `pnpm pack` correctly performs the workspace-dep rewrite; `npm publish` reliably performs the OIDC exchange. If pnpm gains native OIDC support later, the publish step can be simplified back to `pnpm publish` in a follow-up.

- **Risk: trusted publishing cannot publish a package's first version (npm/cli#8544).** → Mitigated by the documented bootstrap procedure (placeholder publish via short-lived classic token, then trusted-publisher binding, then deprecate the placeholder, then revoke the token). One-time per package. After bootstrap, no long-lived credential exists.

- **Risk: trusted-publisher binding pins to the workflow file path and branch; renaming `.github/workflows/deploy-prod.yml` or moving the publish to a non-`release` branch breaks publishing silently until the binding is updated on npmjs.com.** → Accepted as the *intended* security property. Mitigated by documenting the rebinding procedure in `docs/infrastructure.md` so an operator who renames the workflow knows where to look. The symptom is a clear error from `npm publish` ("trusted publisher does not match workflow") — easy to diagnose.

- **Risk: `npm publish --dry-run` in PR CI does not catch errors that only surface after authentication (e.g. registry-side rate limits, scope-permission misconfiguration).** → Accepted. The dry-run gate is a strict subset of pre-flight validation; the release-time publish remains the source of truth. Acceptable because the dry-run catches the high-frequency client-side errors and the post-auth failure modes are rare and operator-resolvable.

- **Risk: the smoke test is a false-positive source if `demo.ts` itself becomes broken for unrelated reasons.** → Mitigated by `demo.ts` already being a CI-load-bearing artifact (it's the canonical SDK reference per CLAUDE.md and is built every PR via `pnpm -r build`). Any breakage shows up in two places, which is fine.

- **Risk: a bad publish ships to npm before anyone notices.** → Mitigated by `npm deprecate @workflow-engine/sdk@<bad-version> "<reason>"` (within or after the 72h unpublish window). Documented in `docs/infrastructure.md`. Republishing the same version is forbidden by npm; the next CalVer bump supersedes it.

- **Trade-off: lockstep version of core means core gets bumped when only sdk changed, and vice versa.** → Accepted. Wastes version numbers, costs nothing, removes a per-PR judgment call.

- **Trade-off: `^2026.5.0` resolves through 2027, so authors with caret ranges get a year of breaking ManifestSchema changes silently in their lockfile updates.** → Same as `^0.x` under SemVer, where every minor is allowed to break. Net-neutral. Author docs (out of scope for this change) can recommend pinning exactly or using `~` for month-only updates if the audience grows.

- **Trade-off: runtime-semantics forward compatibility (sandbox-stdlib precision, plugin shapes) is not addressed.** → Out of scope per Goals. Mitigated by discipline: don't break runtime semantics in patch/minor server releases. If this becomes a real failure mode, address it in a follow-up change.
