## Context

The workflow SDK exposes `defineWorkflow({env: {...}})` to authors. Each binding is either a literal string or an `EnvRef` produced by `env({name?, default?})`. The Vite plugin's build pipeline evaluates the tenant's bundled IIFE inside a Node `vm.createContext` (`runIifeInVmContext`) to discover exports. In that evaluation, `defineWorkflow` calls `resolveEnvRecord(config.env, process.env)`, resolves each `EnvRef` against the Node process's real `process.env`, and returns a `Workflow` with a plaintext `env: Record<string, string>`. The plugin reads `workflow.env` and writes it into the manifest as `env`.

At invocation time, the *same* IIFE source executes inside QuickJS. `defineWorkflow` runs again, but now `getDefaultEnvSource()` reads `globalThis.process?.env` — which is `undefined` in QuickJS (no `process` shim is installed by any plugin). `resolveEnvRecord` falls back to each binding's `default:`. The guest-visible `workflow.env` is the defaults-only view.

The practical effect: workflow authors who set `env({ name: "TOKEN" })` at build time and export a real value via CI get the `default` at runtime in the sandbox. `manifest.env` records the correct value but nothing consumes it inside the guest. This is a latent bug rather than a documented design — every existing in-repo workflow either declares identical defaults or does not depend on the runtime value matching the build-time one.

The upcoming secrets feature needs a reusable mechanism for per-invocation installation of runtime-supplied data onto `globalThis.workflow`. Landing that mechanism now — paired with a minimal consumer that fixes the env gap — keeps the plumbing change separate from the security-sensitive crypto + scrubber work that follows.

## Goals / Non-Goals

**Goals:**
- Close the env gap: `workflow.env.X` at invocation returns the build-time-resolved value from `manifest.env`.
- Introduce a single typed contract in `@workflow-engine/core` (`RuntimeWorkflow<Env>`, `GuestGlobals`, `installGuestGlobals`) that both the runtime's injector plugin and the SDK's `defineWorkflow` consume.
- Add exactly one new sandbox plugin hook (`PluginSetup.onPost`) in preparation for the scrubber that lands in the workflow-secrets change.
- Ship as an isolated, additive, observable improvement whose correctness can be verified without any crypto primitives.

**Non-Goals:**
- No secret handling, no ciphertext, no decryption path. `RuntimeSecrets` is declared (so its shape is fixed) but no plugin installs it.
- No `secret()` SDK factory. No `env({secret: true})`. Both land in workflow-secrets.
- No scrubber. The `onPost` hook exists and is wired through `post()`, but `env-installer` does not implement it — the hook is functionally unused after this change.
- No changes to the build-time env resolution path. `runIifeInVmContext` and `resolveEnvRecord` continue to populate `manifest.env` as they do today.
- No changes to manifest schema (`env: Record<string, string>` stays as-is).
- No collision detection on `installGuestGlobals`. Last writer wins silently; multi-plugin contention is a future concern.

## Decisions

### Decision 1: one typed contract in `@workflow-engine/core`

The contract between "runtime writes to `globalThis.workflow`" and "SDK reads from `globalThis.workflow`" goes in core, not SDK or runtime, because both sides need it without cycles. Shape:

```ts
export interface RuntimeWorkflow<
  Env extends Readonly<Record<string, string>> = Readonly<Record<string, string>>,
> {
  readonly name: string;
  readonly env: Env;
}

export interface RuntimeSecrets {
  addSecret(value: string): void;
}

export interface GuestGlobals {
  workflow: RuntimeWorkflow;
  $secrets: RuntimeSecrets;
}

declare global {
  var workflow: GuestGlobals["workflow"];
  var $secrets: GuestGlobals["$secrets"];
}

export function installGuestGlobals(globals: Partial<GuestGlobals>): void;
```

**Why include `RuntimeSecrets` and `$secrets` already?** Declaring the full `GuestGlobals` shape pins the contract once. The workflow-secrets change adds the implementation without reshaping core. This avoids a churn of "add the type, then revise the type." Downsides: the `$secrets` ambient global types as defined even though nothing installs it; guest-side reads in this change's runtime window would see `undefined`. Acceptable — no SDK consumer calls `$secrets.addSecret` yet.

**Alternatives considered.** Putting the contract in SDK (rejected: runtime's plugin needs to import the same interface to type-check `installGuestGlobals` args). Putting key constants instead of a unified interface (rejected: scatters the contract; reviewed as overly string-oriented).

### Decision 2: `Workflow<Env>` extends `RuntimeWorkflow<Env>` in SDK

`Workflow<Env>` stays generic and branded, but the name/env portion inherits from core. `defineWorkflow` at runtime narrows from `globalThis.workflow` (typed as `RuntimeWorkflow<Record<string, string>>`) to the author-declared env shape via a cast:

```ts
function defineWorkflow<E extends Record<string, string | EnvRef>>(
  config?: DefineWorkflowConfig<E>,
): Workflow<Readonly<{ [K in keyof E]: string }>> {
  type ExpectedEnv = Readonly<{ [K in keyof E]: string }>;
  const raw = globalThis.workflow;
  return Object.freeze({
    [WORKFLOW_BRAND]: true,
    name: raw?.name ?? config?.name ?? "",
    env:  (raw?.env ?? {}) as ExpectedEnv,
  });
}
```

Author ergonomics unchanged: `workflow.env.TOKEN` types precisely as `string`, autocompletes, rejects unknown keys.

### Decision 3: `defineWorkflow` reads `globalThis.workflow`, not its own config, at runtime

At runtime `defineWorkflow` ignores `config.env` entirely. The env comes from the runtime-installed global. At build time (Node-VM discovery), the plugin sets `globalThis.workflow` *before* running the IIFE so `defineWorkflow` reads it consistently in both contexts. Build-time `resolveEnvRecord` remains the source of truth for `manifest.env` contents — it runs inside the Vite plugin's own setup of the Node VM context, not inside `defineWorkflow`.

**Alternatives considered.**
- A Proxy on `workflow.env` that revives values at access time (rejected: superfluous complexity for plain strings).
- A `process.env` shim (rejected: widens the sandbox globals allowlist for no gain; no other consumer needs `process.env`).
- Keep `defineWorkflow` calling `resolveEnvRecord` at runtime but install a `process.env` shim from the plugin (rejected: double resolution — plugin resolves, then SDK re-resolves — and the plugin would have to pre-resolve anyway).

### Decision 4: `PluginSetup.onPost` hook added alongside existing lifecycle hooks

`PluginSetup` gains a single new optional property:

```ts
onPost?: (msg: WorkerToMain, ctx: RunContext) => WorkerToMain;
```

Invoked in `post()` inside `packages/sandbox/src/worker.ts` in plugin topological order against every `WorkerToMain` message before it crosses to main. Plugins receive the message, may transform it, return the (possibly modified) message.

**Why add the hook now, without a consumer?** It removes sequencing risk from the workflow-secrets change: the scrubber code there is mechanical once the hook site exists. Splitting the hook landing earlier also isolates any sandbox-test churn to a change that doesn't involve crypto review.

**Why not call it something more specific?** We considered `onEmit` (already used in some drafts) but `post()` is the concrete chokepoint; `onPost` matches the code-site name and avoids confusion with `ctx.emit`.

### Decision 5: env-installer plugin is worker-thread-only; guest source is trivial

The `env-installer` plugin's `source` (Phase 2, runs in guest) does one thing:

```ts
installGuestGlobals({
  workflow: { get name() { return currentName; }, env: envObject },
});
```

where `currentName` and `envObject` are closure-scoped module-level bindings. `envObject` is a mutable plain `Record<string, string>`; `currentName` is a `let` variable. Guest functions `$env/populate(name, envStrings)` and `$env/clear()` are registered; the worker-side `onBeforeRunStarted` / `onRunFinished` hooks invoke them via `vm.callFunction` host→guest.

Worker-side state: the plugin holds `envStrings` from the run context and calls `$env/populate(name, envStrings)` before the handler dispatches. On `onRunFinished`, it calls `$env/clear()`.

**Why host→guest calls rather than letting onBeforeRunStarted mutate `envObject` directly?** `onBeforeRunStarted` runs on the worker thread but the `envObject` closure lives inside the QuickJS VM's memory space. Worker code has a vm handle but no direct JS object reference to `envObject` — mutation has to go through a registered guest function. This matches how other plugins already cross the vm boundary.

### Decision 6: no collision detection on `installGuestGlobals`

`installGuestGlobals(globals)` iterates `Object.keys(globals)` and calls `Object.defineProperty(globalThis, key, { value, writable: false, configurable: false })`. Two plugins both declaring `workflow` in their `installGuestGlobals` call would produce a runtime TypeError on the second `defineProperty` (because `configurable: false`). That's strict enough — we don't need a richer collision-checking layer today. If a future plugin author intentionally wants to override, they can use `configurable: true` and manage the contention explicitly.

### Decision 7: behavior change is shipped without a flag

The env-gap fix produces visibly different `workflow.env.X` values at runtime for any workflow that declared `env({ name: "X" })` with a build-time override that differed from `default:`. We ship this change without gating because:

1. The new behavior is the intuitive one. Authors who read `env({ name: "TOKEN" })` expect `TOKEN` to be populated from env at deploy time.
2. Existing in-repo workflows all declare identical `default:` values OR don't override, so the observable effect on the repo is zero.
3. A flag would require maintaining two code paths indefinitely for a bug-fix.
4. The upgrade note documents the change explicitly so external tenants have notice.

## Risks / Trade-offs

- **[Risk] An external tenant was silently relying on the defaults-only behavior.** → Mitigation: explicit upgrade-note entry documenting the change as a deliberate fix. Low likelihood given the behavior is counter-intuitive.
- **[Risk] `Object.freeze` on `workflow.env` is dropped.** → Previous behavior froze `env`; mutation-in-place requires not freezing. Authors who tested `Object.isFrozen(workflow.env)` would observe the change. Not a documented contract. Worth noting in upgrade notes.
- **[Risk] `declare global` in `@workflow-engine/core` types `globalThis.workflow` and `globalThis.$secrets` across all consumers, even main-process Node code.** → Mitigation: ambient globals type as `RuntimeWorkflow | undefined` / `RuntimeSecrets | undefined` (well, as `RuntimeWorkflow` per the `var` declaration — but accessing them in Node returns `undefined` at runtime). A future cleanup can move the ambient augmentation into a side-effect-imported file if noise becomes a problem.
- **[Risk] Two-file workflow-runtime contract vs the single interface we've settled on.** → We've decided on a single `GuestGlobals` type. Adding a future guest-visible global is a one-line change here.
- **[Trade-off] The plugin's guest source still calls `installGuestGlobals` at Phase 2.** → This is the standard plugin initialization shape and does not introduce new sandbox concepts.

## Migration Plan

1. Merge the core + sandbox-plugin extension in the same PR (both additive, no behavior change visible yet).
2. Merge the SDK `Workflow<Env>` extension + `defineWorkflow` runtime-read refactor.
3. Merge the `env-installer` plugin + runtime-composition wiring. This is the merge point where `workflow.env.X` at runtime begins to return build-time-resolved values.
4. Publish the upgrade note. No state wipe, no tenant re-upload, no env-var changes.

Rollback: revert the runtime composition commit if an observed regression in env behavior surfaces. Core + sandbox + SDK changes can remain landed because they're additive and inert without the env-installer plugin.

## Open Questions

None that block implementation. The `$secrets` ambient global being pre-declared in core without a corresponding installer is deliberate — it's the contract workflow-secrets will consume.
