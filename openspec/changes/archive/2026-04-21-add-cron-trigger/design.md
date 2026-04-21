## Context

The runtime already has a `TriggerSource<K>` plugin contract (`packages/runtime/src/triggers/source.ts`) designed for exactly this extension: one source per kind, `reconfigure(view)` pushed by the `WorkflowRegistry` on every state change, shared kind-agnostic `executor.invoke` dispatch. The HTTP source (`packages/runtime/src/triggers/http.ts`) is the reference implementation.

The SDK's `httpTrigger` is callable + branded + exposes readonly config as own properties. The vite-plugin discovers exports by brand symbol and AST-transforms calls at build time (already used for `action()` name injection and for `cronitor` workflow name resolution).

Upload goes through `POST /api/workflows/<tenant>` with Ajv-validating the tenant manifest. The executor returns a kind-agnostic `{ ok, output } | { ok: false, error }` envelope, which the trigger source translates back to its protocol.

The per-`(tenant, workflow.sha)` runQueue serializes invocations per workflow. HTTP and cron invocations share this queue.

## Goals / Non-Goals

**Goals:**

- Cron as a first-class trigger kind, symmetric with HTTP: same `TriggerSource` contract, same executor envelope, same invocation lifecycle, same archive/pending persistence.
- Compile-time safety on `schedule` (catch typos and off-by-field errors at build, not runtime).
- Default `tz` resolved at build time so the manifest is self-describing and deterministic across restarts.
- Author ergonomics: no `ctx`, no `cron.daily()` builder, no second dependency to learn — just `cronTrigger({ schedule: "0 9 * * *", handler })`.
- Manual "Run now" parity with HTTP triggers in the `/trigger` UI.

**Non-Goals:**

- Durable schedule state. No `lastFiredAt` persistence; restarts silently skip missed ticks.
- Non-standard cron extensions (`L`, `W`, `#`, `?`, named months/days, 6-field sec-level). Standard 5-field only.
- Tick catch-up or retry. If the engine was down, ticks are lost without a log entry.
- Multi-instance scheduling. Horizontal scaling would double-fire every tick; out of scope. Documented as a known limit.
- New lifecycle event types (`missed`, `scheduled`, etc.). Cron fires produce the existing `started → completed/failed` pair.
- Dashboard surfacing of `nextFireAt`. Deferred to a follow-up change once the base scheduler lands.

## Decisions

### D1: Two libraries — `ts-cron-validator` (type-level) + `cron-parser` (runtime)

**Decision:** Validate `schedule` at TypeScript compile time using `ts-cron-validator`'s `validStandardCronExpression` template-literal type, and compute `nextDate(now, tz)` at runtime using `cron-parser`.

**Rationale:** No single library provides both good compile-time types and a battle-tested runtime parser. `ts-cron-validator` is a pure type-level validator — it has no runtime cost and catches typos before upload. `cron-parser` is the mature reference implementation for IANA-tz-aware cron iteration. Separating the concerns keeps each dependency at what it does best.

**Alternatives considered:**
- Hand-rolled parser. Rejected — historically a nest of DST/tz edge cases, not worth the bytes saved.
- Structured discriminated union (`{every: 'day', at: {hour, minute}} | {cron: string}`). Rejected — user chose the cron-string variant for terseness and familiarity.
- `croner` (unified parser+scheduler). Rejected — we own `setTimeout`; paying for a scheduler we ignore doesn't help.
- Template-literal-typed runtime library (one library for both). Rejected — none exists at ecosystem maturity.

### D2: Per-trigger `setTimeout` chain, delays clamped to 24h

**Decision:** Each cron entry in `reconfigure(view)` gets its own `setTimeout(fire, min(Δ, 24h))`. On fire: run `executor.invoke`, then compute the next `Δ` from the current clock, re-arm.

**Rationale:** Simplest correct design. No shared polling tick, no min-heap. `setTimeout` silently overflows past ~24.8 days (fires immediately for Number overflow); clamping to 24h avoids that, plus naturally picks up tz rule changes and clock-jump correction at each 24h re-compute.

**Alternatives considered:**
- Shared `setInterval(60_000)` polling tick. Rejected — wastes cycles when 0 triggers registered; introduces minute-rounding surprises.
- Min-heap of next-fire times. Premature for v1's expected trigger counts (small).

### D3: Build-time `tz` default via SDK factory

**Decision:** If a `cronTrigger({...})` call omits `tz`, the SDK factory itself resolves the default to `Intl.DateTimeFormat().resolvedOptions().timeZone` at construction time. No AST transform is introduced for cron triggers.

**Rationale:** The manifest must carry a concrete `tz` so runtime scheduling is deterministic regardless of the host process's `TZ` env. The vite-plugin already evaluates each workflow bundle in Node (`node:vm`) to walk branded exports — that's how it discovers `HttpTrigger.path`, `Action.name` (after AST injection), and the `Workflow` config today. When the plugin evaluates the bundle, `cronTrigger({...})` runs on the build host in Node, where `Intl.DateTimeFormat().resolvedOptions().timeZone` returns the host's IANA zone (not `"UTC"`). The plugin then reads the resolved `tz` off the evaluated export for the manifest — the same pattern used for `HttpTrigger.path`.

Action names need AST injection because the name must equal the export *identifier*, which a factory cannot see from inside its own body. `tz` has no identifier dependency — a plain factory default at construction time is sufficient and simpler.

**QuickJS resilience:** the factory also runs in the sandbox when the runtime loads the bundle (workflow module-level `cronTrigger({...})` calls execute on every sandbox construction, not just once at build). QuickJS ships without `Intl`, so `Intl.DateTimeFormat()` throws `ReferenceError` inside the sandbox. The factory catches this and falls back to `"UTC"` for the sandbox-side `.tz` property — a value which is never read by the runtime (the cron source schedules from the *manifest*-derived descriptor, which carries the build-host-resolved zone). Without this fallback, bundle load crashes on every cron trigger and every scheduled fire surfaces `cron.invoke-threw: "Intl is not defined"`.

**Alternatives considered:**
- Vite-plugin AST rewrite that injects `tz: "..."` into the source. Rejected — adds MagicString transform, post-bundle "did transform run" validation, and AST pattern-matching complexity for no information gain. The factory default achieves the same manifest result.
- Post-process the emitted manifest directly. Rejected — diverges source from manifest; re-reading the evaluated export gives back an unresolved tz.
- Require explicit `tz` always. Rejected — imposes boilerplate on every trigger for the 95% single-developer / single-zone case.
- Resolve `tz` inside the QuickJS sandbox at runtime. Rejected — QuickJS's Intl returns `"UTC"`; that's the wrong context for this default. The factory only runs in QuickJS at runtime for action `__dispatchAction`; trigger factories execute on the build host during plugin evaluation.

### D4: Host-side Ajv validation on upload (defence in depth)

**Decision:** Core's Zod `ManifestSchema` validates the cron descriptor: (a) a regex pattern for standard 5-field cron on the `schedule` field, and (b) a `.refine()` on `tz` that probes validity via `new Intl.DateTimeFormat('en-US', {timeZone: tz})` in a try/catch (memoized per zone). Validation failures return `422` with the Zod `issues`. (Manifest validation in this codebase lives entirely in Zod — Ajv is used only for runtime HTTP payload validation and action-input schemas.)

The `Intl.DateTimeFormat` probe is authoritative: it accepts every zone ICU knows, including aliases like `UTC`, `Etc/UTC`, `GMT` that `Intl.supportedValuesOf('timeZone')` omits (it returns only "preferred" zone names).

**Rationale:** The SDK + plugin gate catches most bad values at build time, but hand-crafted bundles (test fixtures, manual tarballs) can bypass that. The upload endpoint is the authoritative gate into runtime state. Rejecting at `POST /api/workflows/<tenant>` gives immediate feedback to the uploader and prevents broken state from landing in the registry.

**Alternatives considered:**
- Trust the SDK/plugin exclusively. Rejected — admits hand-crafted bundles with unknown tz, which would throw at `cron-parser` construction inside `reconfigure`, surfacing as a less useful error later.
- Re-validate at `reconfigure` time in the source. Rejected — duplicates work, masks upload-gate bugs, and requires the source to carry a `skippedEntries` observability surface that nothing else needs.

### D5: Silent missed-tick policy on restart

**Decision:** On `reconfigure(view)` (including first-load post-restart), compute `nextDate(now, tz)` and arm `setTimeout` for that. Past-due ticks are not fired. No missed-tick lifecycle event, no warning log, no persisted `lastFiredAt`.

**Rationale:** The v1 runtime already has a no-durable-state, no-retry posture for invocations (`recover()` only marks orphaned pending records as `failed: engine_crashed`; it does not re-run them). Extending that posture to cron keeps the mental model consistent and avoids adding a new storage surface. Operators diagnose missed ticks by correlating downtime logs with schedule — a known trade-off.

**Alternatives considered:**
- Fire one missed tick on restart. Rejected — requires persisted `lastFiredAt`; writes-per-fire; no natural place to write it atomically with the fire.
- Emit a `missed` lifecycle event. Rejected — requires the same persistence; adds a new event type for observability that nothing downstream consumes.
- Log `cron_armed` at every reconfigure. Rejected — user chose silent; cron firing itself already logs via the existing logging consumer (`started`/`completed`/`failed`).

### D6: Unbounded runQueue enqueue on tick

**Decision:** Every tick fires `executor.invoke`, which enqueues behind any in-flight work on the same `(tenant, workflow.sha)` runQueue. No coalescing, no dropping, no depth cap.

**Rationale:** The runQueue only grows while the engine is *running and blocked by a slow handler* — outages don't accumulate ticks (no `setTimeout` fires when the process is down). Growth is therefore bounded in practice by the duration of the blocking handler. Simpler semantics: every fire produces one archive entry, same as HTTP.

**Alternatives considered:**
- Coalesce queued ticks per trigger (one queued tick represents any number of missed fires). Rejected — user preferred the honest "one tick, one invocation" model even under congestion.
- Drop ticks when runQueue is busy. Rejected — silently kills cron if a single action call hangs.

### D7: DST semantics inherited from `cron-parser`, documented

**Decision:** The `triggers` (or cron-trigger) spec documents that DST "spring forward" skipped local times resolve to the next existing instant, and "fall back" repeated local times fire once. No code wraps `cron-parser` to alter this.

**Rationale:** This is well-known ecosystem behavior. Wrapping it to be "smarter" (e.g. firing twice on fall-back) would surprise anyone who's worked with cron before and introduces bug surface.

### D8: Manual "Run now" bypasses the cron source

**Decision:** The `/trigger` UI's "Run now" button for a cron trigger calls `executor.invoke(tenant, workflow, descriptor, {}, bundleSource)` directly, the same code path as HTTP "Run now" (which already uses `executor.invoke` directly). The cron source is not involved.

**Rationale:** The executor is already kind-agnostic. Routing through `cronSource.fireNow(...)` would couple the UI to a kind-specific API, duplicate dispatch logic, and break the symmetry with HTTP. Scheduled ticks keep running in parallel; a manual fire during a pending scheduled tick simply enqueues alongside it.

## Risks / Trade-offs

- **[Silent missed ticks on restart]** → Documented as a known v1 limit in the cron-trigger spec. Operators correlate downtime with schedule manually. A follow-up change can add `lastFiredAt` persistence + missed-tick events if demand surfaces.
- **[Multi-instance double-firing]** → The spec explicitly constrains cron to single-instance runtimes. Horizontal scaling requires leader election (out of scope). Attempting to run ≥2 instances with overlapping tenant views will fire every tick ≥2 times.
- **[DST surprise on local schedules]** → `0 2 * * *` in a zone with DST fires at 03:00 on spring-forward days and once on fall-back days (per `cron-parser`). Documented in the spec; authors wanting exact timing can use `tz: "UTC"`.
- **[runQueue congestion delays ticks]** → A slow HTTP handler (or long action call) in the same workflow delays every subsequent cron tick by the handler's duration. Each queued tick still lands in the archive as a separate invocation; observability is preserved.
- **[ICU skew across build host and runtime host]** → A bundle built against a newer IANA zone list may fail Ajv validation at upload on a runtime with older ICU data. The error is explicit (`iana-tz` Ajv issue). Mitigation is keeping Node versions aligned across build + runtime; no code-level guard.
- **[Node `setTimeout` max]** → Clamping to 24h eliminates the overflow footgun for yearly schedules. Daylight savings transitions are naturally observed on the next 24h recompute.

## Migration Plan

No data migration. No pending/archive state needs to be wiped — existing HTTP-only records remain valid. The `ManifestSchema` change is a widening (new discriminant value `"cron"`); existing HTTP-only manifests continue to validate.

Deployment steps:

1. Merge this change; no storage-side action needed.
2. Restart the runtime. No tenant re-upload is required for tenants with only HTTP triggers.
3. Author cron triggers in `workflows/*.ts`; rebuild + `wfe upload --tenant <name>`.

Rollback: revert the change. Any tenant bundle already uploaded with cron triggers will fail `ManifestSchema` validation on the previous runtime version and refuse to load. Operators redeploy the HTTP-only version of the bundle or stay on the new runtime.

## Open Questions

None at proposal time. All design threads resolved in the exploration session.
