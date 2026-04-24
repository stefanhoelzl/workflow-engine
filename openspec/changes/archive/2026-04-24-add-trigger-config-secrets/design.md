## Context

Workflow secrets today flow along a single path: authors declare them via `env({ secret: true })` in `defineWorkflow`; the Vite plugin records their names in `manifest.secretBindings`; `wfe upload` encrypts CLI-env values into `manifest.secrets`; the runtime decrypts on sandbox spawn and the `secrets` plugin installs a frozen `globalThis.workflow = {name, env}` before the guest module evaluates. Handler bodies read plaintext via `globalThis.workflow.env.X`.

Trigger descriptors (`cronTrigger`, `httpTrigger`, `manualTrigger`) carry their configuration as plain strings in the manifest. `TriggerSource` implementations (`packages/runtime/src/triggers/{cron,http,manual}.ts`) run main-side and receive these strings via `reconfigure(owner, repo, entries)`. There is currently no mechanism for a descriptor field to reference a workflow secret — the decryption infrastructure only runs per-sandbox, the plaintext lives inside the worker, and `TriggerSource` backends never see it.

Concrete forcing function: a future IMAP-style trigger needs credentials (host, user, password) to open a persistent connection *before* any handler runs. The handler-local `globalThis.workflow.env` accessor can't help — it's only live inside an invocation's worker.

## Goals / Non-Goals

**Goals:**
- Let a string-typed field of any trigger descriptor carry a reference to a workflow-declared secret, resolved to plaintext before the `TriggerSource` sees it.
- Unify the author-facing secret accessor: `wf.env.X: string` usable at any read site — inside a trigger factory (build-time) or inside a handler body (sandbox-runtime) — with the same ergonomics as a plain string variable.
- Share the sentinel format between producer (SDK) and consumers (worker-side scrubber, main-side resolver); no duplication of the `\x00secret:NAME\x00` encoding.
- Support substring sentinels so JavaScript template literals compose naturally (`` `Bearer ${wf.env.TOKEN}` ``, `` `imaps://${wf.env.USER}:${wf.env.PASS}@host` ``).
- Fail loudly, at a single validation site (workflow registration), when a sentinel references a name absent from `manifest.secrets`.

**Non-Goals:**
- Introducing a new trigger kind (IMAP, HMAC-verified HTTP, etc.). Those consumers land in follow-up changes once the plumbing exists.
- Making `TriggerSource` a public or externally-pluggable extension point.
- Main-thread `Secret<>` wrapper / self-redacting string type.
- Main-thread scrubber over `TriggerSource` outputs (the scrubber remains worker-side only).
- Upload-time cross-validation that every sentinel name exists in `manifest.secrets` (TSC catches author-side typos; the registry catches everything else at load).
- Caching plaintext on the main thread. Decryption runs once per workflow registration and once per sandbox spawn; optimization deferred.
- Migrating action-body code away from `globalThis.workflow.env.X`. Both access paths remain valid; `wf.env.X` is additive.

## Decisions

### D1. `wf.env.X: string` at every read site — mechanism piggybacks on existing context sensitivity

`defineWorkflow` already has two branches (`packages/sdk/src/index.ts:172-222`):

- **Runtime branch** (line 181-189): reads `globalThis.workflow` (installed frozen by the `secrets` plugin at Phase 2 with plaintext values for secret entries) and returns it. `wf.env.SECRET_X` → plaintext. Unchanged by this design.
- **Build-time branch** (line 190-221): `globalThis.workflow` is absent; `resolveEnvRecord(config.env, process.env)` produces the env record. Today this branch *skips* `SecretEnvRef` entries (line 131-133 of the same file), leaving `wf.env.SECRET_X === undefined` at build time.

**Delta**: `resolveEnvRecord` SHALL emit `encodeSentinel(value.name ?? key)` for each `SecretEnvRef` entry instead of skipping it. That is the entire mechanism. No getters, no symbol-based markers, no new context detection — the existing runtime/build-time split already does the work.

After the delta:
- `wf.env.SECRET_X` at build time: `"\x00secret:SECRET_X\x00"` (string).
- `wf.env.SECRET_X` at runtime: plaintext (string).
- `` `Bearer ${wf.env.TOKEN}` `` at build time: `"Bearer \x00secret:TOKEN\x00"` — a composed string with embedded sentinel. Flows through trigger factories into the manifest unchanged.

*Alternatives considered:*
- Explicit `Object.defineProperty` getters on each secret entry. Rejected as unnecessary complexity — `resolveEnvRecord`'s existing shape already picks the correct value per context.
- A separate `SecretEnvRef`-typed build-time handle, distinct from the runtime string. Rejected: two access paths, author footgun.

### D2. `SecretEnvRef` stays SDK-internal

The branded ref object returned by `env({ secret: true })` continues to exist — `defineWorkflow` inspects it to collect `secretBindings` and `resolveEnvRecord` inspects it to emit sentinels — but is not exposed on the author-facing type of `wf.env`. The return type of `wf.env` remains `Readonly<Record<keyof Env, string>>` (same as today). Authors never see or type against `SecretEnvRef` at read sites.

*Rationale:* matches author intuition ("env.X is a string"); unifies trigger-config and handler-body access; eliminates the need for a `Secretable<T>` type-widening at trigger factory boundaries. Cost: zero — the SDK's current return type is already `Record<string, string>`, so no type surface changes.

### D3. Shared sentinel helpers inlined in core's `index.ts`

`packages/core/src/index.ts` (the same file that already hosts the manifest schema, `installGuestGlobals`, `RuntimeWorkflow`, etc.) gains two exports:

- `encodeSentinel(name: string): string` — validates `name` against `/^[A-Za-z_][A-Za-z0-9_]*$/`, returns `\x00secret:NAME\x00`.
- `SENTINEL_SUBSTRING_RE: RegExp` — global regex `/\x00secret:([A-Za-z_][A-Za-z0-9_]*)\x00/g`.

The helpers are inlined in `index.ts` rather than a sibling file, matching the existing `RuntimeWorkflow` / `installGuestGlobals` precedent: the `?sandbox-plugin` esbuild transform resolves `@workflow-engine/core` directly to `index.ts` and does not reliably pick up sibling `.ts` modules.

Importers:

- **SDK** (`resolveEnvRecord` in `packages/sdk/src/index.ts`) → `encodeSentinel`.
- **Main-side resolver** (`packages/runtime/src/triggers/resolve-secret-sentinels.ts`, new) → `SENTINEL_SUBSTRING_RE`.

The worker-side scrubber at `packages/runtime/src/plugins/secrets.ts` is unrelated: it redacts *plaintext byte literals* from outbound `WorkerToMain` messages via an `activePlaintexts` list, not sentinel patterns. It does not import from the shared sentinel module.

*Alternatives considered:*
- `{$secretRef: name}` object sentinel at each field. Rejected: forces every trigger descriptor Zod schema to accept `string | {$secretRef: string}`, explodes the type surface. String sentinels cost nothing here because the sentinel is valid UTF-8, `\x00` is unlikely to collide with any real config string, and `z.string()` validates untouched.
- Parallel `secretBindings: Record<fieldPath, secretName>` map alongside the descriptor. Rejected: two representations of the config (plain-with-holes + side map), awkward with nested paths.

### D4. Substring resolution (not whole-value only)

The resolver uses `str.replace(SENTINEL_SUBSTRING_RE, (match, name) => …)` — every sentinel occurrence in a string is replaced with its plaintext. Composed strings like `` `Bearer ${wf.env.TOKEN}` `` resolve correctly.

*Alternatives considered:*
- Whole-value-only matching, rejecting partial strings that contain a sentinel. Rejected on reconsideration: the only argument for whole-value was "interpolation invites template-based leakage," but the confinement invariant (D7) enforces non-leakage independently of resolution shape. Substring is strictly more expressive at no safety cost, and it uses the same shared regex the scrubber already applies.

### D5. Registration-time resolution, decrypt-on-demand

The workflow registry's load path (called at `wfe upload` → registry install, and at boot for persistence replay):

```
registry.install(owner, repo, manifest):
  plaintextStore = decryptWorkflowSecrets(manifest, keyStore)   # new call site on main
  missing = Set()
  resolvedEntries = entries.map(e => ({
    ...e,
    descriptor: resolveSecretSentinels(e.descriptor, plaintextStore, missing),
  }))
  if missing.size > 0:
    throw WorkflowRegistrationError({code: "secret_ref_unresolved", missing})
  groupByKind(resolvedEntries).forEach((kind, resolved) =>
    triggerSource(kind).reconfigure(owner, repo, resolved))
```

`resolveSecretSentinels` deep-walks objects and arrays; for each string it runs `str.replace(SENTINEL_SUBSTRING_RE, …)`; missing names are accumulated and the sentinel left in place (the walk's callers throw only after the full walk so they can report every missing name at once).

No cache. `decryptWorkflowSecrets` continues to run on sandbox spawn as today, and now additionally runs once per workflow registration. Crypto cost is presumed negligible; revisit if profiling shows otherwise.

Flow diagram (registration to first cron fire):

```
wfe upload
    │
    ▼
Server: registry.install(owner, repo, manifest)
    ├── decryptWorkflowSecrets(manifest)          ──► plaintextStore
    ├── resolveSecretSentinels(trigger descs, store) ──► resolvedEntries   (or throw 400)
    └── triggerSource("cron").reconfigure(owner, repo, resolvedCronEntries)
                                            │
                                            ▼
                    CronTriggerSource stores plaintext schedule, starts timer
                                            │
                                            ▼                (tick)
                                    executor.invoke(...)
                                            │
                                            ▼
                                    sandbox-store spawns worker:
                                    decryptWorkflowSecrets(manifest)  ──► plaintextStore
                                    secrets plugin installs globalThis.workflow.env
                                    module evaluates → wf.env getters see the global
                                        → return plaintext to handler code
```

### D6. Failure mode: single site, structured error

`resolveSecretSentinels` never throws. The caller (`registry.install`) inspects `missing` and throws `WorkflowRegistrationError({code: "secret_ref_unresolved", workflow, missing: [...]})`. Surfaces:

- **Upload path** (`POST /api/workflows/<owner>`) → HTTP 400 `{error: "secret_ref_unresolved", workflow, missing}`.
- **Persistence replay at boot** → logged; that single workflow is absent from the registry until re-uploaded; other workflows load normally.

This is the sole validation site. No upload-time pre-walk on the server side (TSC catches typos in author code; `resolveSecretSentinels` catches toolchain / tampering regressions at load). No runtime re-check inside `TriggerSource` implementations — they trust the contract.

### D7. SECURITY.md §5: plaintext confinement within engine code

Trigger plaintext lives on the main thread by necessity (cron's in-memory timer, a future IMAP client's connection state, a future HMAC verifier's key). Passing plaintext to a third-party library at the `TriggerSource` boundary is explicitly permitted and explicitly out-of-scope for memory-lifetime guarantees — third-party code may stash, buffer, or cache the value.

The invariant fences *our* code: plaintext MUST NOT appear in log lines, event payloads, error messages, HTTP responses, dashboard renders, bus traffic, or any code path whose purpose is not to implement a trigger backend. Two supporting invariants: (a) sentinels MUST be resolved only via `resolveSecretSentinels` — `TriggerSource` implementations MUST NOT parse sentinels themselves; (b) the sentinel format MUST NOT be duplicated across modules.

### D8. Coexistence with `globalThis.workflow.env`

The existing handler-body access pattern `globalThis.workflow.env.X` keeps working unchanged — in fact, `wf.env.X`'s runtime getter reads *from* `globalThis.workflow.env[name]`. Both access paths read the same frozen record. No migration required for existing workflows; author code that uses the old pattern continues to compile and execute.

## Risks / Trade-offs

- **[Sentinel collision with real string content]** → the sentinel prefix is `\x00secret:` — the NUL byte is unlikely in legitimate config. Mitigation: `encodeSentinel` rejects names outside `/^[A-Za-z_][A-Za-z0-9_]*$/`; if a legitimate config value ever contained a NUL byte followed by `secret:ALPHA_NAME\x00`, the resolver would try to substitute it. No real-world trigger config contains this pattern; no mitigation beyond documentation.
- **[VM-eval assumption]** → the build-time getter behavior assumes the Vite plugin evaluates the workflow module in a clean VM with no `globalThis.workflow` set. Verified at `packages/sdk/src/plugin/index.ts:212` (`runIifeInVmContext`). Mitigation: add a unit test asserting that `defineWorkflow` inside a bare Node context yields sentinels.
- **[Third-party library plaintext retention]** → once we pass credentials to (e.g.) an IMAP client, we can't bound how long plaintext lives in that library's memory. Mitigation: SECURITY.md §5 acknowledges the boundary explicitly; beyond the TriggerSource handoff, engine-level lifetime guarantees end.
- **[Decryption runs twice per hot-path firing]** → registration decrypt + sandbox-spawn decrypt. Mitigation: accepted as Option B (no cache) — crypto is presumed cheap; revisit only if profiling shows ≥5% of sandbox-spawn wall time.
- **[Resolved descriptor accidentally logged]** → an engine contributor could add `console.log(entry.descriptor)` inside cron/http/manual sources and leak plaintext. Mitigation: SECURITY.md invariant + code review. No mechanical enforcement (main-thread scrubber is out of scope).
- **[SDK internal `SecretEnvRef` leaking via type inference]** → if `defineWorkflow`'s return type inadvertently surfaces `SecretEnvRef` on `wf.env` entries, authors see a non-`string` type. Mitigation: explicit `Readonly<Record<keyof Env, string>>` annotation on the return; dedicated type tests in `packages/sdk/src/index.test.ts`.
- **[Boot-time registration failures are per-workflow]** → one broken workflow must not poison the whole registry. Mitigation: per-workflow try/catch around `registry.install`; boot logs the failure and continues.

## Migration Plan

Single-PR, lockstep deploy (single-tenant project).

1. Land `packages/core/src/secret-sentinel.ts`. No behavior change.
2. Update `packages/runtime/src/plugins/secrets.ts` to import the regex from core. Same behavior.
3. Land `packages/runtime/src/triggers/resolve-secret-sentinels.ts`. Not yet wired.
4. Update the workflow-registry load path to decrypt + resolve + throw on missing names. Existing manifests (no sentinels) resolve to themselves — behavior-equivalent.
5. Update `packages/sdk/src/index.ts`: stamp effective names on `SecretEnvRef`; build `wf.env` with getters; adjust the public return type to expose `Readonly<Record<…, string>>`.
6. Update SECURITY.md §5 with the three new invariants.
7. Add tests (unit for encode/resolve/getter context; integration using cron `schedule` as the fixture).

**Rollback**: revert the PR. No data migration, no manifest schema change, no persistence format change. Existing workflows that don't use `wf.env.X` in trigger configs are unaffected by either direction of rollback.

## Open Questions

None. Interview resolved the outstanding design questions; this document captures the conclusions.
