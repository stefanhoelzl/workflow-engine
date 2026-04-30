## Context

`SECURITY.md` §2 enumerates what guests can reach on `globalThis` after
sandbox init. The list was hand-maintained and has fallen behind:
`__mail`, `__sql`, `$secrets`, `workflow`, `__wfe_exports__` are all
reachable post-init but absent from §2. The CLAUDE.md invariant that
forbids this drift has, until now, been enforced only by reviewer
attention — there is no test that fails when a plugin adds a global
without updating §2.

Verified against source:

- **Phases.** `packages/sandbox/src/worker.ts:245-263` documents Phases
  0, 1, 1a, 1b, 1c, 2, 3, 4. SECURITY.md §2 currently summarises this
  as "phases 0-5", which doesn't match.
- **Snapshot point.** `worker.ts:324` — `vm.snapshot()` is taken after
  Phase 4 (user source eval). Every subsequent `handleRun` restores
  from this snapshot (`worker.ts:469`). The post-snapshot state IS the
  steady-state guest globals surface.
- **Plugin set.** `packages/runtime/src/sandbox-store.ts:96-108` —
  `buildPluginDescriptors` returns an unconditional list (secrets,
  webPlatform, fetch, mail, sql, sdkSupport, …). Mail/sql plugins
  always load; only `secretsConfig` is workflow-derived.
- **Lockable surfaces today.** `__sdk` (sdk-support), `__sql`
  (sandbox-stdlib/sql), `__mail` (sandbox-stdlib/mail), `workflow` and
  `$secrets` (runtime/plugins/secrets) are all installed via
  `Object.defineProperty(globalThis, name, {writable:false, configurable:false})`
  with a frozen inner object. `__wfe_exports__` is the lone exception:
  the workflow IIFE writes it as an ordinary writable, configurable
  property (sister finding F-4).

This change closes the doc gap and adds a regression guard. F-4 (the
descriptor-anomaly fix for `__wfe_exports__`) is intentionally NOT
bundled — its source finding is not committed to the repo, and we
will not synthesise a structural fix without reading F-4's actual
recommendation.

## Goals / Non-Goals

**Goals:**

- Bring `SECURITY.md` §2 into agreement with the production globals
  surface.
- Add a normative rule (R-14) that makes the "every global is
  enumerated" invariant explicit and citable.
- Add a regression test that fails on additions or removals to the
  globals surface, scoped to the *delta* added by plugins (not the ES
  + engine baseline).
- Reconcile §2's documented boot phases with the actual phase
  numbering in `worker.ts`.
- Update the `sandbox` and `sandbox-stdlib` capability specs so
  future contributors can read the rule from spec, not only from
  SECURITY.md.

**Non-Goals:**

- Locking `__wfe_exports__`'s descriptor or freezing its inner. That
  is F-4 and ships separately, with its own threat assessment.
- Per-global S-threat IDs. We use a single umbrella threat (S15) that
  covers tampering with any locked guest-visible global, mirroring the
  S11 framing for `__sdk`.
- New runtime behaviour, new SDK surface, new HTTP route, manifest
  changes, persistence schema changes.
- Auditing the full ES + quickjs-wasi engine baseline. The test
  measures *plugin-induced delta*, not the raw global key set.

## Decisions

### D1 — Test asserts the delta, not the full set

**Decision.** The enumeration test boots two sandboxes:

1. **Baseline:** `handleInit` with `pluginDescriptors: []` and an
   empty workflow source. Captures
   `BASELINE = Object.getOwnPropertyNames(globalThis)`.
2. **Production:** `handleInit` with `buildPluginDescriptors(workflow,
   keyStore)` and a minimal fixture workflow. Captures
   `PRODUCTION = Object.getOwnPropertyNames(globalThis)`.

The assertion is `(PRODUCTION − BASELINE) === EXPECTED_DELTA`, where
`EXPECTED_DELTA` is the union of inline const arrays grouped by source
plugin:

```ts
const SDK_SUPPORT_GLOBALS = ["__sdk"] as const;
const SECRETS_GLOBALS     = ["workflow", "$secrets"] as const;
const SQL_GLOBALS         = ["__sql"] as const;
const MAIL_GLOBALS        = ["__mail"] as const;
const WORKFLOW_GLOBALS    = ["__wfe_exports__"] as const;
const TIMERS_GLOBALS      = ["setTimeout", "setInterval",
                             "clearTimeout", "clearInterval"] as const;
const FETCH_GLOBALS       = ["fetch"] as const;
const CONSOLE_GLOBALS     = ["console"] as const;
const WEB_PLATFORM_GLOBALS = [/* … as listed in SECURITY.md §2 … */] as const;
```

**Why.** A full-set assertion would force enumerating ~80+ ES standard
library names plus the quickjs-wasi engine baseline. That is not what
R-14 cares about; R-14 cares about *what plugins add*. A delta-based
assertion stays stable across engine bumps and only flags what
auditors actually need to review.

**Alternative considered.** Snapshot the full set with
`toMatchSnapshot`. Rejected: snapshot-blessing is one keystroke; this
is exactly the audit posture R-14 forbids.

### D2 — Test exfiltrates names via a fixture workflow handler

**Decision.** A minimal fixture workflow at
`packages/runtime/src/globals-surface.test.ts (inline BUNDLE_SOURCE)` exports a
`listGlobals` handler:

```ts
import { defineWorkflow, manualTrigger } from "@workflow-engine/sdk";
const wf = defineWorkflow({ env: {} });
export const listGlobals = wf.action({ name: "listGlobals" })(() =>
  Object.getOwnPropertyNames(globalThis).sort()
);
export const trigger = manualTrigger({/* … */}, listGlobals);
```

The test calls `sandbox.run("listGlobals", {})` and reads the array
from the run result.

**Why.** The high-level `Sandbox` API does not expose raw `vm.evalCode`,
and adding a debug-eval channel would itself be a new sandbox surface
— a security regression. Returning names through a regular handler
uses only the existing host-bridged execution path.

**Alternative considered.** Add a worker-only debug message that runs
arbitrary code. Rejected: any new sandbox surface needs §2 treatment
of its own; meta-circular.

### D3 — Phase-numbering reconciliation expands §2 prose

**Decision.** Update SECURITY.md §2's "Boot sequence" prose to enumerate
the actual phases from `worker.ts:245-263` (0, 1, 1a, 1b, 1c, 2, 3, 4)
rather than rewriting the worker to collapse to 0-5.

**Why.** No code churn; the existing phase decomposition is correct
and intentional (sub-phases let plugin authors reason about WASI hook
ordering vs. guest-function install vs. plugin source eval). The doc
just lagged.

### D4 — Umbrella threat S15 instead of per-global threats

**Decision.** Add one threat row:

> **S15** — Guest code mutates a locked guest-visible global (`__sql`,
> `__mail`, `$secrets`, `workflow`, `__wfe_exports__`) to swap its
> dispatcher, alter its frozen view, or replace its exports between
> runs. Mitigation: the locked-outer + frozen-inner descriptor pattern
> uniformly applied at install time (see R-2). For `__wfe_exports__`
> specifically, the lock is missing today and is tracked as a separate
> change (sister finding F-4); guests CAN currently mutate it, but
> handler exports are read once per run by the host, so the practical
> impact is bounded to the same run.

**Why.** Five separate S-threats would mostly duplicate the S11
framing. One umbrella row keeps the table compact and matches the
existing "lock + freeze" pattern as a single class.

### D5 — R-14 phrased over *own properties* of `globalThis`

**Decision.**

> **R-14 Globals are enumerated.** Every own property of `globalThis`
> present after the post-init snapshot — minus the ES standard
> library and the quickjs-wasi engine baseline — MUST appear in §2
> "Globals surface (post-init guest-visible)". The enumeration test in
> `packages/runtime/src/globals-surface.test.ts` MUST pass under the
> production plugin descriptor set returned by `buildPluginDescriptors`.

**Why.** "Reachable" includes prototype additions (`Iterator.prototype.map`
from core-js); those aren't *own* globals and don't belong to §2. The
test and the rule's wording are coupled — we picked the formulation
both can agree on.

### D6 — Spec deltas live on `sandbox` and `sandbox-stdlib`

**Decision.**

- `openspec/specs/sandbox/spec.md` gets the R-14 requirement and the
  phase-numbering reconciliation.
- `openspec/specs/sandbox-stdlib/spec.md` gets per-plugin enumeration
  of the global each contributes (`__sql`, `__mail`) plus the locked-
  outer/frozen-inner pattern as the canonical shape for any future
  system-bridge plugin.

**Why.** R-14 is a sandbox-level invariant (it governs *the* boundary).
Per-plugin globals are a stdlib concern. Splitting keeps each spec
self-contained.

### D7 — Document `workflow` raw global plus SDK indirection

**Decision.** The §2 bullet for `workflow` reads roughly:

> `workflow` (frozen `{name, env}`, locked descriptor; populated by the
> secrets plugin's Phase-2 IIFE from `__secretsConfig`. Author-facing
> access is `workflow.env[k]` from inside `defineWorkflow({env}).env(...)`
> in the SDK, but the binding is reachable directly on `globalThis`.)

**Why.** §2 is a threat-model document; it must reflect what's actually
on `globalThis`, not just the polite SDK surface. SDK indirection is
useful context for readers cross-referencing the SDK source.

### D8 — F-4 unbundled

**Decision.** This change does NOT modify `worker.ts` to lock
`__wfe_exports__`. The §2 bullet documents it as it exists today
(writable, configurable, populated by the workflow IIFE) and footnotes
that locking is tracked separately.

**Why.** F-4's finding has no committed source we could read; the
"lock + freeze" resolution we sketched in interview was synthesised,
not verified. Bundling it would commit the codebase to a fix shape we
can't justify from F-4's actual text. Splitting keeps F-6 a clean
doc-only-plus-test change and lets F-4 land with its own threat
assessment.

## Risks / Trade-offs

- **[Risk] Engine baseline drift between baseline-no-plugins and
  production sandbox boots.** quickjs-wasi might bind a global lazily
  on first plugin invocation, so the baseline could under-count. →
  Mitigation: D1's delta is computed by sets, not lists, so a name
  present in both cancels out cleanly. If a global appears only after
  plugin init but is engine-supplied, the test will flag it as a
  plugin addition — at that point we either document it in §2 or move
  it to a known-engine-extras allow-list with a comment citing the
  quickjs-wasi version that introduced it.

- **[Risk] `pluginDescriptors: []` baseline boot may fail because some
  invariant assumes at least one plugin.** → Mitigation: verified by
  reading `runPluginBootPipeline` (`worker.ts:358-420`) — every loop
  is over the descriptor list and degenerates cleanly when empty.
  Phase 4 evalCode runs even with no plugins. If a future change adds
  a "must have N plugins" guard, the test breaks loudly and we adjust.

- **[Risk] R-14 references a specific test file path; renaming the
  file silently weakens the rule.** → Mitigation: accepted. The path
  is named in both R-14 and the spec; a rename PR has to update both
  in the same diff. Alternative would be a pluginless rule "an
  enumeration test exists and gates merges", which is harder to grep
  for in code review.

- **[Trade-off] Umbrella S15 vs. per-global S15–S17.** Granular IDs
  give per-CVE-style traceability; the umbrella keeps the threat
  table compact. Chose compact because the mitigation is uniform; if
  per-global tracing becomes needed (e.g. for a CVE database), S15
  can be split later without a spec change.

- **[Trade-off] Inline const arrays vs. snapshot file.** Inline forces
  a code review touch for every globals change; snapshot files are
  one-keystroke blessable. Inline aligns with R-14's audit posture
  even at the cost of slightly noisier diffs.

## Migration Plan

No data migration. No tenant-visible behaviour change. Test ships
green on first run if §2 and the inline const arrays are in sync; CI
will fail loudly if they drift in a future PR.

Rollback is a `git revert` of the change PR — pure doc + test reverts
cleanly, no state to undo.

## Open Questions

- **Q1.** Are there engine-supplied globals (e.g. `print`,
  `globalThis`, internal QuickJS bindings) that quickjs-wasi exposes
  beyond the WASM-extension list already documented in §2? The
  baseline boot will tell us; resolved during task implementation, not
  blocking spec sign-off.
