## 1. Shared sentinel helpers in core

- [x] 1.1 Add `encodeSentinel(name)` and `SENTINEL_SUBSTRING_RE` (and the internal name-validation regex) inline in `packages/core/src/index.ts`, in their own section with a comment referencing both producer (SDK) and consumer (trigger-config resolver). Inlining in `index.ts` matches the existing `RuntimeWorkflow` / `installGuestGlobals` precedent (`?sandbox-plugin` esbuild resolver constraint).
- [x] 1.2 Add the two symbols to the single `export { … }` block at the bottom of `packages/core/src/index.ts`.
- [x] 1.3 Unit tests in `packages/core/src/secret-sentinel.test.ts` (test files MAY live beside `index.ts` — only production code is bound by the inline-only constraint): `encodeSentinel` accepts valid names; throws on empty / whitespace / dashes / leading digits; produces the exact `\x00secret:NAME\x00` byte sequence. `SENTINEL_SUBSTRING_RE` matches whole-value, embedded, multi-occurrence; name capture group is correct in each case.
- [x] 1.4 `pnpm --filter @workflow-engine/core build` succeeds (if a core build step exists; otherwise skip); `pnpm lint` and `pnpm check` green on the new symbols.

## 2. SDK build-time sentinel emission

- [x] 2.1 Update `packages/sdk/src/index.ts` `resolveEnvRecord`: for `SecretEnvRef` entries, instead of `continue` (current line 131-133), emit `resolved[key] = encodeSentinel(value.name ?? key)`. Import `encodeSentinel` from `@workflow-engine/core`.
- [x] 2.2 Ensure the existing `secretBindings` collection (line 206-212) remains unchanged — it already uses `value.name ?? key`, matching the new sentinel name.
- [x] 2.3 Unit tests in `packages/sdk/src/index.test.ts`: `defineWorkflow({env:{X: env({secret:true})}})` in a Node VM yields `wf.env.X === encodeSentinel("X")`. Override case: `env({secret:true, name:"Y"})` yields `wf.env.X === encodeSentinel("Y")`. Template-literal composition: `` `pre-${wf.env.X}-post` `` yields `"pre-" + encodeSentinel("X") + "-post"`. Runtime branch: with a stub `globalThis.workflow = {name, env: {X: "plain"}}`, `wf.env.X === "plain"`.
- [x] 2.4 Type test: `wf.env.X` narrows to `string` (not `SecretEnvRef`, not `string | undefined`) in the build-time branch.
- [x] 2.5 Sanity-check that `SecretEnvRef` remains internal — not re-exported from the SDK public barrel under a name suggesting author use.

## 3. Main-side resolver module

- [x] 3.1 Create `packages/runtime/src/triggers/resolve-secret-sentinels.ts` exporting `resolveSecretSentinels<T>(value: T, plaintextStore: Record<string, string>, missing: Set<string>): T`. Deep-walk plain objects and arrays. For each string: `str.replace(SENTINEL_SUBSTRING_RE, (match, name) => name in plaintextStore ? plaintextStore[name] : (missing.add(name), match))`. Non-string scalars pass through. Do NOT throw.
- [x] 3.2 Unit tests in `packages/runtime/src/triggers/resolve-secret-sentinels.test.ts`: whole-value substitution; embedded substring; multi-occurrence; unknown name accumulates in `missing` and leaves sentinel in place; nested object and array recursion; non-string scalars untouched; empty input (no sentinels) returns byte-identical structure.

## 4. Scrubber coexistence check (no code changes)

- [x] 4.1 Confirm no sentinel code exists in the existing scrubber (`packages/runtime/src/plugins/secrets.ts` uses plaintext-byte redaction via `activePlaintexts`, unrelated to the sentinel regex). No migration needed. Verify scrubber tests remain green after all other tasks land.

## 5. Registry integration

- [x] 5.1 Identify the registry load path that currently groups trigger entries by kind and dispatches to each `TriggerSource.reconfigure` (the requirement "Registry reconfigures backends per-tenant in parallel" in `openspec/specs/workflow-registry/spec.md` points at the code locus).
- [x] 5.2 Before the group-and-dispatch step, call `decryptWorkflowSecrets(manifest, keyStore)` to produce `plaintextStore`. Reuse the existing `packages/runtime/src/secrets/decrypt-workflow.ts` function; do not introduce a cache.
- [x] 5.3 For each trigger entry, call `resolveSecretSentinels(entry.descriptor, plaintextStore, missing)` to produce the resolved descriptor. Use a single `missing: Set<string>` accumulated across all of a workflow's entries.
- [x] 5.4 If `missing.size > 0`, throw `WorkflowRegistrationError({code: "secret_ref_unresolved", workflow: manifest.name, missing: [...missing]})`. Ensure the throw occurs BEFORE any `TriggerSource.reconfigure` call for this workflow.
- [x] 5.5 Map the error to HTTP 400 in the upload handler (e.g. `packages/runtime/src/http/upload.ts` or whatever owns `POST /api/workflows/<owner>`) with body `{error: "secret_ref_unresolved", workflow, missing}`. Verify via integration test.
- [x] 5.6 At `recover()` / boot replay, wrap each workflow registration in a try/catch so a single broken workflow logs a structured error and does not prevent other workflows from registering. Verify via integration test.

## 6. Cron end-to-end integration test (primary fixture)

- [x] 6.1 Author a fixture workflow under `packages/runtime/src/tests/fixtures/` (or the integration-suite's fixture location) declaring `env: { S: env({ secret: true }) }` and `cronTrigger({ schedule: wf.env.S, tz: "UTC", handler: async () => {} })`.
- [x] 6.2 Integration test A (happy path): build the fixture; seal with `S = "* * * * *"` (or similar valid cron) in the CLI env; upload; assert the cron TriggerSource's internal binding has the plaintext schedule (either via a test-only accessor or by observing a fire) and that the manifest persisted on disk still contains the sentinel string.
- [x] 6.3 Integration test B (missing secret): craft a manifest by hand (or via a modified fixture) where the cron schedule contains a sentinel not present in `manifest.secrets`; attempt to register; assert the error code, HTTP status, and that no cron binding was installed.
- [x] 6.4 Integration test C (recovery isolation): persistence replay with two workflows, one valid and one with an unresolved sentinel; assert the valid workflow registers and the broken one does not; error is logged.

## 7. SECURITY.md update

- [x] 7.1 Add a subsection under §5 "Secrets" capturing the main-thread plaintext confinement invariant (permitted in registry + TriggerSource + third-party library boundary; forbidden in logs / events / errors / HTTP / dashboard / bus). Cross-reference `workflow-secrets/spec.md` for the canonical requirement.
- [x] 7.2 Add the "Sentinels resolved only via the shared resolver" invariant: `TriggerSource.reconfigure` MUST receive already-resolved descriptors; sources MUST NOT parse sentinels themselves.
- [x] 7.3 Add the "Sentinel format not duplicated" invariant: producers and consumers MUST import from `@workflow-engine/core/secret-sentinel`.
- [x] 7.4 Update the "NEVER hardcode or commit a secret" invariant block to reference trigger-config-carried secrets alongside the existing env/action-body flow.

## 8. Definition of Done

- [x] 8.1 `pnpm lint` green across the monorepo.
- [x] 8.2 `pnpm check` green (`exactOptionalPropertyTypes`, `verbatimModuleSyntax` invariants respected; no new `biome-ignore` without justification).
- [x] 8.3 `pnpm test` green (unit + integration; no new WPT impact expected — skip `pnpm test:wpt` unless sandbox-stdlib is touched).
- [x] 8.4 `pnpm validate` green (lint + check + test + `tofu fmt -check` + `tofu validate` — the infra check is a no-op for this change since no `infrastructure/` files are touched).
- [ ] 8.5 Dev-probe end-to-end: `pnpm dev --random-port --kill` boots; upload a fixture workflow exercising `cronTrigger({ schedule: wf.env.S })`; observe paired `invocation.started` / `invocation.completed` events on the cron tick; `.persistence/` events carry no `\x00secret:` bytes.
- [x] 8.6 `demo.ts` deliberately NOT updated (no user-visible consumer ships with this change); confirm no regression in the existing demo-probe checks.
