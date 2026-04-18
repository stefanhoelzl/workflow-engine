## Context

The sandbox ships a WinterCG-MCA polyfill cluster (EventTarget, Event, ErrorEvent, AbortController, AbortSignal + self/navigator/reportError/queueMicrotask/fetch) via the `virtual:sandbox-polyfills` Vite plugin added in change `2026-04-18-sandbox-event-target`. The plugin bundles `packages/sandbox/src/polyfills/entry.ts` + its imports into an IIFE string; the sandbox's own `vite build` inlines that string into `dist/src/worker.js`, which Node's native ESM loader reads when `worker.ts` spawns a `Worker`.

`URLPattern` is the next-priority WinterCG-MCA global still missing. The entire `urlpattern/**` WPT subtree is currently glob-skipped in `packages/sandbox/test/wpt/skip.ts:96` with reason `"needs URLPattern polyfill"`.

Adding URLPattern is a strictly smaller change than the event-target cluster. There is no hybrid-install puzzle, no hand-written subclasses, no cross-polyfill coupling, and no new host-bridge capture-and-delete pattern. The polyfill is a self-installing npm package; the integration is three line-level edits plus documentation.

Verified up-front:

- `urlpattern-polyfill@10.0.0` (MIT, zero runtime deps, pure TS compiled to JS) — source inspection confirms no `eval`, no `new Function`, no Node/DOM APIs, no WebAssembly. The only dynamic code-generation path is `new RegExp(...)` applied to patterns the class itself parsed via its vendored `path-to-regex-modified.ts`.
- The polyfill's `index.js` self-installs the global with a feature-detect guard: `if (!globalThis.URLPattern) globalThis.URLPattern = URLPattern;`. A bare `import "urlpattern-polyfill"` in `entry.ts` installs the class; no wrapper logic is needed on our side.
- `quickjs-wasi@2.2.0` ships QuickJS-NG, which supports ES2022 private class fields (verified via upstream `tests/test_language.js`). The polyfill uses private fields (its stated Node 15+ requirement); `rollup-plugin-esbuild` with `target: "es2022"` in `sandboxPolyfills()` preserves them through bundling.
- `@rollup/plugin-node-resolve` prefers the `module` export over `main`, so the ESM `./index.js` wins over the CJS `./index.cjs` at bundle time — which is what we want; the `globalThis.URLPattern = URLPattern` self-install line is in the ESM entry.

## Goals / Non-Goals

**Goals:**

- Ship `globalThis.URLPattern` as a constructable guest global backed by a pure-JS polyfill, with no host-bridge surface.
- Drop the `urlpattern/**` glob skip in `skip.ts`; classify any concrete per-subtest failures with specific non-polyfill reasons (per `skip.ts`'s stated convention).
- Amend `/SECURITY.md §2` allowlist and `openspec/specs/sandbox/spec.md` in lockstep with the source changes (the §2 rule requires allowlist extension in the same PR).

**Non-Goals:**

- Wiring a default QuickJS `interruptHandler` to bound long-running guest execution. The sandbox already accepts one as an option (`Requirement: Interrupt handler configuration`), but the runtime does not currently pass one; this is a pre-existing posture that applies equally to `RegExp` and `while(true){}`. Addressing it is a separate change (see Decision 7).
- Exposing URLPattern to consumers as a host-side utility. The polyfill is guest-side only; the runtime does not use URLPattern for its own trigger-path routing.
- Auditing the polyfill's vendored `path-to-regex-modified.ts` fork against every upstream `path-to-regexp` CVE. See Decision 5 for the posture we take.

## Decisions

### Decision 1: Use `urlpattern-polyfill@10.0.0` rather than hand-rolling a URLPattern implementation

**Rationale:** Hand-rolling a spec-conformant URLPattern is ~1–2k LOC of pattern-parser + regex-emitter that would need its own test suite to approach the existing WPT coverage. The polyfill is MIT-licensed, zero-runtime-dep, pure-JS, and is the implementation the WHATWG spec repository itself references for non-browser environments. The cost-benefit of hand-rolling is nowhere near break-even.

**Rejected alternatives:**

- **`path-to-regexp` direct use:** URLPattern is a superset — constructor protocol forms, grouping semantics, and the `exec`/`test` surface don't reduce cleanly to raw path-to-regexp. We'd rebuild the delta anyway.
- **Skip URLPattern, document as out-of-scope:** the global is WinterCG-MCA mandated; npm libraries that route in-sandbox increasingly feature-detect it. Deferring indefinitely postpones the allowlist amendment but doesn't reduce its eventual scope.

### Decision 2: Pin the polyfill to an exact version (`10.0.0`), not a caret range

**Rationale:** A new guest-visible global is a §2 allowlist extension. The allowlist audit is version-specific: a reviewer auditing `urlpattern-polyfill@10.0.0`'s vendored `path-to-regex-modified.ts` today does not thereby audit `10.1.0` tomorrow. Pinning makes the audit target immutable per `pnpm-lock.yaml`'s tarball hash; any upstream version bump becomes a distinct PR with its own §2 re-audit gate. This is a stronger posture than the caret ranges used elsewhere in the repo precisely because the §2 allowlist lives downstream of the version choice.

### Decision 3: Bare `import "urlpattern-polyfill"` in `entry.ts`, no wrapper file

**Rationale:** The polyfill's own `index.js` runs the install under a feature-detect guard. The install produces a writable/configurable/enumerable own-property of `globalThis` — the same descriptor shape `event-target.ts`'s `Object.defineProperty` loop produces for its class globals. There is no semantic benefit to wrapping the install in our own source.

The only argument for a wrapper is audit-trail visibility: with a bare import, a `/SECURITY.md §2` reader looking for "where does `URLPattern` get installed on globalThis" has to open `node_modules/urlpattern-polyfill/index.js`. We close this gap by putting the install-site pointer in §2's own prose — the §2 entry quotes the polyfill's install line verbatim, so §2 is self-contained for audit purposes. Combined with Decision 2's version pinning, the review workflow is: check `pnpm-lock.yaml` → read `10.0.0`'s 4-line `index.js` → done.

**Rejected:**

- **Wrapper with `Object.defineProperty(globalThis, "URLPattern", {writable, configurable, enumerable})`:** identical runtime behavior to bare import; adds a file for review-ergonomic reasons that §2 prose handles more efficiently.
- **Subpath import `import { URLPattern } from "urlpattern-polyfill/urlpattern"` + explicit `globalThis.URLPattern = URLPattern`:** install site moves into our tree, but the wrapper file is back. Same tradeoff as above, same rejection.

### Decision 4: Add `URLPattern` to `RESERVED_BUILTIN_GLOBALS`

**Rationale:** Every other shim-installed global (EventTarget, Event, ErrorEvent, AbortController, AbortSignal, plus the WASM-ext set) is in the reserved set at `packages/sandbox/src/index.ts:75`. The set drives the collision check at line 189, which rejects `extraMethods: { URLPattern: … }` at sandbox-construction time. Omitting `URLPattern` would silently allow a host to shadow the polyfilled global with a host-bridged one — a consistency bug at best, an isolation-boundary bug at worst.

The existing test at `sandbox.test.ts:1374` already iterates the reserved set; extending its array by one string covers the shadow-rejection case with no new test scaffolding.

### Decision 5: Drop the `urlpattern/**` WPT glob skip entirely; classify concrete failures per-subtest

**Rationale:** `skip.ts` (as reworked in commit `8306662`) inverts the old `spec.ts` model: pass is implicit, skip entries require a reason. The stated convention at `skip.ts:10-12` is that `grep '"needs .* polyfill"' skip.ts` reconstructs the polyfill-gap backlog; once a polyfill lands, its matching `"needs <X> polyfill"` lines are removed, not kept as narrower skips.

The Apr 18 event-target change set the precedent: it flipped entire `dom/events/**` and `dom/abort/**` directories to implicit-pass in a single edit. We follow that precedent: delete the `urlpattern/**` line outright; add per-subtest entries only for concrete divergences surfaced by the trial `pnpm test:wpt` run, each with a specific reason (e.g. `"polyfill diverges from spec on X"`), never with `"needs … polyfill"`.

### Decision 6: §2 framing — "identical isolation to RegExp", not "inherent to the spec"

**Rationale:** The naïve framing "URLPattern ReDoS is inherent to the URLPattern spec and unchanged from native browsers" is misleading. Native browser URLPattern implementations use C++ regex engines (V8 Irregexp, WebKit JavaScriptCore) with bounded-time matching guarantees; this sandbox uses QuickJS-NG's interpreted libregexp, which does exhibit catastrophic backtracking on adversarial patterns. The framings are not equivalent.

The *honest* framing ties the risk to the sandbox's isolation model:

- Pattern-side user input can trigger catastrophic regex backtracking in QuickJS's engine.
- This is the identical attack surface that `RegExp` (an existing guest global) already exposes.
- The blast radius is bounded to the invoking workflow's own worker thread by per-workflow worker_thread isolation — the host main thread and other workflows' workers are unaffected.
- No new attacker capability is introduced: a workflow author who wants to hang their own worker can already do so via `new RegExp("(a+)+b").test("a".repeat(30))`.

§2 carries this framing as the risk-class parenthetical in URLPattern's enumeration entry. No separate residual-risk paragraph is added, because there is no cluster of new risks to bundle — the risk class is a single known one, already documented implicitly by RegExp's presence in the allowlist.

### Decision 7: Inherit the sandbox's existing interrupt-handler posture, don't change it

**Rationale:** The sandbox supports an optional `interruptHandler` (see `Requirement: Interrupt handler configuration` in `openspec/specs/sandbox/spec.md`), but the runtime does not currently pass one — so in practice guest code can loop or backtrack forever, bounded only by worker_thread isolation (other workflows and the host main thread stay responsive). Additionally, QuickJS-NG's libregexp backtracking loop does not poll interrupt flags mid-match, so even a wired handler would not terminate a hung regex.

Consequence: today, a workflow author can hang their own worker indefinitely with pure-JS (`while(true){}`), with RegExp (`new RegExp("(a+)+").test(...)`), or — after this change — with URLPattern. All three are bounded to the author's own worker. This change does not widen the gap; it inherits the existing posture. Wiring a default interrupt deadline at the runtime layer (and, if needed, patching libregexp to poll interrupts) is out of scope and tracked independently.

### Decision 8: No new behavioral unit tests in `sandbox.test.ts`

**Rationale:** The event-target change's tasks.md added ~12 behavioral test scenarios because hybrid-H install + hand-written AbortController/AbortSignal carry non-trivial host-boundary invariants (event.isTrusted === false, preventDefault suppresses `__reportError`, reserved globals win over extraMethods).

URLPattern has none of those. It is pure compute with no host bridge, no capture-and-delete, no `__reportError` forwarding. WPT owns the behavioral coverage; the one host-boundary invariant (reserved-globals collision) is already tested by the loop at `sandbox.test.ts:1374`, which costs one string to extend.

Adding a dedicated `new URLPattern("...").exec("...")` unit test would duplicate WPT coverage inside a slower host-spawned sandbox for no isolation-boundary-specific gain. The Apr 18 change pruned exactly these duplicates from `sandbox.test.ts` ("pure-spec duplicates pruned — WPT now owns EventTarget/Event/Abort* behavior"); we follow that precedent.

## Risks / Trade-offs

- **Polyfill behavioral divergence from native URLPattern** → Mitigation: WPT `urlpattern/**` runs the canonical spec tests. Any divergence surfaces as concrete per-subtest failures that we document in `skip.ts` with specific reasons (Decision 5). We accept spec divergence within the polyfill's known gaps; we do not hand-fix the polyfill.
- **Future `urlpattern-polyfill` version bump changes install semantics** → Mitigation: exact version pin (Decision 2) + §2 audit-trail pointer (Decision 3) make bumps explicit PRs with their own §2 re-audit gate.
- **Pattern-side ReDoS hangs a workflow worker** → Not mitigated by this change; inherited from the sandbox's current interrupt-handler posture (Decision 7). Bounded to the invoking workflow by worker_thread isolation; host and other workflows unaffected. Workflow authors must treat URLPattern inputs like `RegExp` inputs (pattern trusted, matched-against value untrusted).
- **Polyfill's vendored `path-to-regex-modified.ts` has divergent CVE lineage from upstream `path-to-regexp`** → Accepted: the regex *engine* is QuickJS's (already exposed via `RegExp`); the polyfill only emits regex strings. The vendored fork affects quantitative CPU-burn under pathological patterns but does not introduce a new attacker capability beyond what `RegExp` already exposes.

## Migration Plan

None. Guest-facing addition only: workflow authors gain access to `URLPattern` as a constructable global. No existing sandbox API changes. No host-bridge signature changes. No runtime migration. Rollback is a straight revert of the three source edits, the `skip.ts` line re-insertion, the `SECURITY.md §2` entry removal, and the sandbox spec deltas.

## Open Questions

None at proposal time. Any subtest failures surfaced by `pnpm test:wpt` during implementation are classified per Decision 5 — not a design-time question.
