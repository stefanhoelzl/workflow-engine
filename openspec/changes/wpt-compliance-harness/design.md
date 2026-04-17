## Context

The QuickJS sandbox (`packages/sandbox`) runs user workflow code with a minimal auditable surface: `console`, timers, `crypto`, `fetch`, `URL`, `Headers`, `TextEncoder/Decoder`, `atob/btoa`, `structuredClone`, `performance`. The recent `2026-04-16-quickjs-wasi-migration` swapped to `quickjs-wasi` and added WASM extensions for most of those. What is still missing, measured against the WinterCG Minimum Common API (MCA):

- `globalThis.self`, `navigator.userAgent`, `reportError`, `DOMException`, `queueMicrotask`
- `AbortController`, `AbortSignal`
- `EventTarget`, `Event`, `CustomEvent`, `ErrorEvent`
- Constructible `Request`, `Response`, `FormData`, `Blob`, `File`
- `ReadableStream`, `WritableStream`, `TransformStream` and the streams family
- `CompressionStream`, `DecompressionStream`, `URLPattern`, `FileReader`

This change does not ship those polyfills. It builds the **measurement infrastructure** that enumerates every gap at subtest granularity. The annotated output becomes the polyfill backlog for future rounds.

Web Platform Tests (WPT) is the canonical cross-browser conformance corpus. Deno, Node, Cloudflare workerd all run WPT subsets against their runtimes. No official WinterCG conformance suite exists; the pragmatic approach is "run the WPT tests corresponding to the APIs MCA lists".

## Goals / Non-Goals

**Goals:**
- Systematic measurement of WinterCG MCA coverage inside the sandbox.
- Subtest-granular reporting: the vitest output lists each subtest that passed, failed, or is skipped (with reason).
- A single human-authored `spec.ts` flat map that classifies every WPT test as `pass` or `skip` with reason. This file IS the polyfill backlog.
- Reproducible vendor: pinned upstream commit, committed `manifest.json` + transitive closure of runnable files.
- Safe against guest misbehavior: guest infinite loops, OOMs, and setup exceptions do not hang the test process.
- Three MCA-mandated production globals (`self`, `navigator.userAgent`, `reportError`) added to the sandbox with documented rationale.

**Non-Goals:**
- Shipping any new polyfill (EventTarget, AbortController, Request/Response, streams, etc.).
- CI integration — local-only via `pnpm test:wpt`.
- Supporting network-dependent WPT tests that require a live WPT test server.
- URLPattern, CompressionStream, FileReader polyfills (identified but deferred).
- Wiring the `interruptHandler` TODO in `worker.ts` — the WPT runner does not depend on it.

## Decisions

### D1. Two-state classification: `pass` / `skip` (no `fail`)

Chose two explicit states plus `reason` rather than three (`pass` / `fail` / `skip`). File-level `fail` and `skip` were functionally equivalent (neither runs); the "fail" wording added ceremony without value. All non-passing cases are `skip` with a `reason` string that carries the justification (e.g., `"needs AbortController polyfill"`, `"no browser origin model"`).

**Alternatives considered:**
- Three states with `fail` reserved for "expected to fail but still run to detect drift upward" — rejected because the flip-when-polyfill-lands workflow is simpler when there is no asymmetric state.
- Four states adding `todo` — rejected as redundant with `skip + "not yet classified"`.

### D2. Flat map instead of include/exclude/expectations

Single `Record<string, { expected, reason? }>` keyed by glob pattern or `file:subtest` syntax. Collapses three previously-separate concepts (inclusion list, exclusion list, per-file expectations) into one. Simpler to edit, review, and diff.

### D3. Specificity-based pattern matching with severity tiebreak

Match rule: most-specific pattern wins. Specificity = count of non-wildcard characters in the file-part + `1_000_000` boost if the pattern carries a subtest suffix. Ties broken by severity: `skip > pass`.

This handles the common cases cleanly:
- `fetch/api/**` (skip) + `fetch/api/headers/**` (pass) → pass for headers, skip for the rest
- `**/idlharness-*.any.js` (skip) + `dom/events/**` (pass) → pattern with higher literal char count wins; severity breaks the tie if equal

**Alternatives considered:**
- First-match (source-order) — rejected: fragile against re-ordering, hard to review
- Last-match — same objection
- Fail-over-pass — asymmetric, doesn't handle pass-overriding-fail cleanly

### D4. All worker-scope WPT in the manifest, not hand-curated dirs

Applicability is structural: a test enters the manifest iff its META `global=` directive includes any worker-scope (`worker`, `dedicatedworker`, `sharedworker`, `serviceworker`, `shadowrealm`) OR omits `global=` entirely (WPT default includes workers). No hand-curated list of directories.

Rationale:
- Principled definition rather than arbitrary dir selection
- New upstream tests auto-appear in the report as `"not yet classified"` (triage signal)
- Vendor size stays small: only pass-classified files + their transitive deps get copied
- Manifest grows to ~12–15k entries for full worker-scope coverage; still tractable

### D5. Lean manifest (no full subtest inventory)

Manifest per entry: `{ scripts, timeout?, skippedSubtests? }` OR `{ skip: { reason } }`. No full list of every subtest name. Subtest names come from **runtime observation**, not static parsing.

Rationale:
- Static subtest-name extraction via regex is imperfect (~80–90%; dynamic names via template literals miss)
- Saves ~15MB of manifest size
- Vendor script becomes simpler (no parse pass)
- Drift detection still works: if `skippedSubtests` declares a name that never appears in a run, the runner synthesizes a failing `it()` suggesting the rename

### D6. Top-level-await runner, not async describe

Runner pattern (`packages/sandbox/test/wpt/wpt.test.ts`):
1. Import spec + manifest synchronously
2. Partition into `[runnable, skipped]`
3. `await limitedAll(runnable.map(runWpt), CONCURRENCY)` — owned concurrency control
4. Synchronously register `describe` + `it` from observed results

**Spike-verified rejections** (see `spike/` directory):

| Pattern | 12k files | Why rejected |
|---|---|---|
| async `describe` + dynamic `it()` | ~600s | Vitest collects async describes sequentially within a file; linear scaling unusable |
| `beforeAll` + gated hooks + pre-declared `it()` | fails | Gated hooks trip vitest's 10s `hookTimeout`; also requires static subtest names |
| **top-level await + sync register** | **27s** | Own concurrency control, no hooks, dynamic names handled |

Default concurrency: `max(4, os.availableParallelism() * 2)`. WPT work is CPU-bound (QuickJS in WASM inside Node Worker threads); 2x gives modest I/O/IPC overlap without thrashing. Override via `WPT_CONCURRENCY` env.

### D7. `reportError` as host-bridge instead of EventTarget-dispatching

Spec-compliant `reportError(err)` dispatches an `ErrorEvent` on `self`, which requires EventTarget (deferred). Instead, ship a guest-side shim that serializes the Error object and calls a new `__reportError` host-bridge method.

- Production: the bridge's host-side impl forwards to the runtime logger
- Tests: override per-run via `sandbox.run(..., { extraMethods: { __reportError } })`
- When EventTarget lands, shim evolves to dispatch locally AND call the bridge — contract-compatible

Matches the existing `fetch`/`__hostFetch` pattern: shim handles ergonomics, bridge carries JSON-marshalled data across the Worker boundary. Risk class is identical to `console.log`.

### D8. Vendor-time META resolution + runtime-consumed manifest

`scripts/wpt-refresh.ts` does the heavy lifting once per refresh:
- Parse META `global=`, `script=`, `timeout=`
- BFS-walk `script=` references transitively
- Apply `.sub.js` template substitution with fixed placeholder values
- Classify via spec.ts (most-specific match)
- Copy runnable files + deps to `vendor/`
- Emit `vendor/manifest.json`

Runtime test runner stays simple: read manifest, read source files already on disk, compose, run, compare. No META parsing at test time.

### D9. External watchdog instead of QuickJS interruptHandler

`interruptHandler` is TODO in `worker.ts:220` (blocked on postMessage-serialization of host callbacks). The WPT runner doesn't wait for it. Instead: host-side `setTimeout` watchdog that calls `sb.dispose()` on deadline. `dispose()` rejects the pending run promise AND `worker.terminate()`s the Node Worker thread — a force-kill that works even when the VM is CPU-bound.

Deadline scales with META: 10s default, 45s for `META: timeout=long`.

### D10. SECURITY.md §2 Option A amendment

Current wording: `NEVER add a global, host-bridge API, or Node.js surface to the QuickJS sandbox (§2)`. Strictly read, prohibits even reviewed additions. Intent was "no unreviewed additions".

Amendment: add `without extending the §2 allowlist in the same PR` qualifier. Allowlist becomes explicitly authoritative. Precedent set so future polyfill rounds follow the same PR shape.

## Risks / Trade-offs

- **Manifest size (~5–10MB after full refresh)** → Tractable. Commits produce big diffs on refresh but reviewable. Mitigation: vendor-refresh PRs are distinct from ordinary code PRs.

- **Vitest rendering 60–100k test rows** → Not benchmarked beyond the 12k simulated. If vitest's reporter/TUI chokes, fallbacks: split into multiple test files (one per top-level WPT dir, vitest's pool parallelizes across files); or custom JSON reporter. Not expected to be needed on first landing.

- **Static META parse fragility** → Vendor script relies on regex parsing of `// META:` lines. Uncommon spacing or comment positioning could trip it. Mitigation: log any unparseable META directive as a warning during refresh; start with small iterations.

- **`.sub.js` substitution could mask real test intent** → Tests substituting `{{host}}` + then doing real network calls break at the fetch layer, not the parse layer. Mitigation: the `{{host}}` scan marks those tests as structural skip with reason "contains network dependency" before they ever run.

- **Watchdog force-kill loses mid-test diagnostics** → A WPT test whose VM deadlocks gets `dispose()`d; we see a test failure but not a stack trace. Mitigation: logs show which test timed out; manual debugging with `WPT_CONCURRENCY=1` reproduces. For typical WPT tests, 10s deadline is generous.

- **Subtest-drift detection via "declared-skip-never-observed"** → If upstream renames a subtest, old name entry in `skippedSubtests` shows as a synthesized failing `it()`. Clear signal, but cryptic if you don't know the pattern. Mitigation: the synthesized error message says `"spec declares skip for '<name>', but subtest never ran (renamed upstream?)"`.

- **Memory pressure from 30+ concurrent VMs on small machines** → `memoryLimit: 128MB × concurrency` could exceed container limits. Mitigation: concurrency default has floor of 4, env override available, `memoryLimit` tunable per-sandbox.

- **`reportError` is partial without EventTarget** → Library authors doing `globalThis.addEventListener('error', ...)` to catch errors won't work. EventTarget isn't shipped; `addEventListener` doesn't exist, so this code can't run. The partial implementation won't cause silent wrong behavior. When EventTarget lands, shim upgrades to dispatch locally.

## Migration Plan

No rollback concerns — new test-only infrastructure + three low-capability production globals + one write-only bridge. Deployment is a normal PR landing with `pnpm test:wpt:refresh` runnable on any developer machine.

First-run flow on a fresh developer checkout:
1. `pnpm install`
2. `pnpm test:wpt:refresh` — clones WPT, populates vendor, generates manifest (~30s)
3. `pnpm test:wpt` — runs suite, reports per-subtest status (~1–3 min)

## Open Questions

None material to this round. The `interruptHandler` TODO in `worker.ts:220` stays tracked for production use cases; the WPT runner does not depend on it.
