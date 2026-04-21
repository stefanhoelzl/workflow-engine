## 1. Dependencies

- [x] 1.1 Add `ts-cron-validator` as a dependency of `@workflow-engine/sdk` (used for compile-time `schedule` typing in the SDK public API)
- [x] 1.2 Add `cron-parser` as a dependency of `@workflow-engine/runtime` (used by the cron source for `nextDate(now, tz)`)
- [x] 1.3 Run `pnpm install` and verify the lockfile updates in both packages

## 2. Core manifest + types

- [x] 2.1 In `@workflow-engine/core`, extend the manifest trigger descriptor union with a `{ name, type: "cron", schedule, tz, inputSchema, outputSchema }` shape; update `BaseTriggerDescriptor<K>` consumers accordingly
- [x] 2.2 Extend the `ManifestSchema` Zod object to accept `type: "cron"` with required `schedule` (string, 5-field cron regex), `tz` (non-empty string), `inputSchema` (object), `outputSchema` (object)
- [x] 2.3 Unit-test `ManifestSchema` round-trips for valid and invalid cron descriptor shapes (missing tz, malformed schedule, unknown type discriminant)

## 3. SDK surface

- [x] 3.1 Export `CRON_TRIGGER_BRAND = Symbol.for("@workflow-engine/cron-trigger")` from `@workflow-engine/sdk`
- [x] 3.2 Add `cronTrigger(config)` factory returning a branded callable with readonly `schedule`, `tz`, `inputSchema`, `outputSchema` own properties. `inputSchema = z.object({})`, `outputSchema = z.unknown()`. If `config.tz` is omitted, the factory SHALL default `tz` to `Intl.DateTimeFormat().resolvedOptions().timeZone` at construction time (resolved on the build host when the vite-plugin evaluates the bundle)
- [x] 3.3 Type the `schedule` parameter using `ts-cron-validator`'s `StandardCRON<S>` template-literal type so invalid cron literals fail at compile time
- [x] 3.4 Add `isCronTrigger(value)` type guard and include `CronTrigger` in the exported `Trigger` union
- [x] 3.5 Unit-test: branded callable invocation, inspectable properties, compile-time rejection of invalid schedule string (tsd or type-assertion test)

## 4. Vite plugin

- [x] 4.1 Extend brand-symbol discovery in `packages/sdk/src/plugin/` to recognize `CRON_TRIGGER_BRAND`
- [x] 4.2 Extend workflow-manifest emission to write the cron descriptor shape `{ name, type: "cron", schedule, tz, inputSchema, outputSchema }` by reading `schedule` and `tz` off each evaluated `CronTrigger`-branded export (no AST transform; `tz` is resolved by the SDK factory at construction time and travels on the evaluated value)
- [x] 4.3 Plugin unit tests: manifest entry shape for cron trigger with factory-defaulted tz, manifest entry shape for cron trigger with explicit tz, unbranded exports ignored

## 5. Runtime cron source

- [x] 5.1 Create `packages/runtime/src/triggers/cron.ts` implementing `TriggerSource<"cron">`: `start` no-op, `reconfigure(view)` cancels all timers and rearms, `stop()` cancels all timers
- [x] 5.2 Per-entry `setTimeout` chain: compute `nextDate(now, tz)` via cron-parser, clamp delay to 24h max, on wake recompute and re-arm
- [x] 5.3 On fire: call `executor.invoke(tenant, workflow, descriptor, {}, bundleSource)`; arm next tick regardless of invocation outcome
- [x] 5.4 Wire the cron source in `packages/runtime/src/main.ts` alongside the HTTP source; register with the `WorkflowRegistry` plugin host
- [x] 5.5 Unit tests using vitest fake timers: reconfigure cancel+rearm, tick fires executor with `{}`, 24h clamp behavior, stop cancels all timers
- [x] 5.6 Crash-recovery test case: simulate restart (fresh source, no prior state); verify missed ticks are silently skipped, next tick armed from `now`, no lifecycle events emitted for the missed window

## 6. Upload validation

- [x] 6.1 In `@workflow-engine/core`, add an `isValidTimezone(tz)` helper that probes via `new Intl.DateTimeFormat('en-US', {timeZone: tz})` in a try/catch (memoized in a `Map<string, boolean>`) and apply it as a Zod `.refine()` on the cron trigger's `tz` field inside `ManifestSchema`. The probe covers aliases (`UTC`, `Etc/UTC`, `GMT`) that `Intl.supportedValuesOf('timeZone')` omits
- [x] 6.2 Apply a 5-field cron regex (`^[0-9*,\-\/]+(\s+[0-9*,\-\/]+){4}$`) as a Zod `.regex()` on the cron trigger's `schedule` field inside `ManifestSchema`
- [x] 6.3 Integration test: upload with unknown tz returns `422` with Zod issues; upload with malformed schedule returns `422`; upload with valid cron descriptor succeeds

## 7. Trigger UI

- [x] 7.1 Extend `/trigger/<tenant>/<workflow>/` page rendering in `packages/runtime/src/ui/trigger/page.ts` to list cron triggers alongside HTTP triggers, displaying name, schedule, and tz
- [x] 7.2 Render a "Run now" button (no payload form, no Jedison instance) for cron trigger entries
- [x] 7.3 Wire the manual-fire POST handler in `packages/runtime/src/ui/trigger/middleware.ts` to dispatch cron triggers with an empty `{}` payload via `executor.invoke`
- [x] 7.4 Unit tests: cron entry appears in list with schedule+tz rendered, "Run now" button present without Jedison form, POST dispatches once with `{}`, scheduled timers unaffected

## 8. End-to-end integration

- [x] 8.1 Create a fixture workflow under `workflows/` with a cron trigger (e.g., `workflows/src/heartbeat.ts`) exercising default tz injection, explicit tz, and an action call
- [x] 8.2 Integration test: registry upload → cron source reconfigures → fake-timer-advance past next tick → executor invoked with correct tenant/workflow/descriptor/empty-payload. Executor is mocked; the real sandbox path has a pre-existing `virtual:` import failure in main unrelated to this change
- [x] 8.3 Integration test for reconfigure: re-upload tenant with empty workflow list → pending cron timer cancelled → no fire after scheduled instant passes

## 9. Documentation + security

- [x] 9.1 Add a short note to `SECURITY.md` §3 (webhook ingress) clarifying that cron triggers are NOT a new public ingress surface (they have no external caller)
- [x] 9.2 Add an "Upgrade note" bullet to `CLAUDE.md` capturing whether any tenant re-upload is needed (spoiler: no, manifest shape is widened not narrowed)
- [x] 9.3 Run `pnpm validate` (lint + format + type check + tests) and confirm green
