## Why

The platform supports only one trigger kind today (`http`). Time-based automation — periodic syncs, scheduled cleanups, regular polling of upstream APIs — currently requires an external cron service to POST to a webhook, which leaks scheduling concerns outside the workflow boundary and adds an extra hop and failure mode. A native `cron` trigger closes that gap using the existing `TriggerSource` plugin contract (already anticipated by the `triggers` spec) and keeps schedule + handler co-located in the workflow source.

## What Changes

- **NEW** SDK factory `cronTrigger({ schedule, tz?, handler })` exported from `@workflow-engine/sdk`. Callable shape mirrors `httpTrigger`: the returned value is branded with `CRON_TRIGGER_BRAND` and callable as `() => Promise<unknown>`. Handler receives an empty payload `{}`; return value is discarded.
- **NEW** Brand `CRON_TRIGGER_BRAND = Symbol.for("@workflow-engine/cron-trigger")` and type guard `isCronTrigger(value)`.
- **NEW** Compile-time schedule validation via `ts-cron-validator`'s `validStandardCronExpression` — 5-field standard cron only; non-standard flags (`L`, `W`, `#`, `?`, named months/days) are rejected at the type level.
- **NEW** Vite-plugin behavior: brand-discovery picks up `cronTrigger(...)` exports. The SDK factory itself resolves the default `tz` at construction time via `Intl.DateTimeFormat().resolvedOptions().timeZone`; because the plugin evaluates workflow bundles in Node (`node:vm`) to walk branded exports, the resolved value reflects the build host's IANA zone and lands in the manifest without any AST transform.
- **NEW** Manifest trigger entry shape `{ name, type: "cron", schedule, tz, inputSchema, outputSchema }`; `inputSchema` is the JSON Schema of `z.object({})`, `outputSchema` of `z.unknown()`.
- **NEW** Host-side Ajv validation on upload (`POST /api/workflows/<tenant>`): cron `schedule` validated against a standard 5-field regex; `tz` validated against the runtime host's `Intl.supportedValuesOf('timeZone')` via a custom Ajv keyword. Invalid upload → `400`.
- **NEW** Runtime `TriggerSource<"cron">` at `packages/runtime/src/triggers/cron.ts`. Per-trigger `setTimeout` chain; `nextDate(now, tz)` computed via `cron-parser`. Delays > 24h clamped to 24h and recomputed on wake (correct handling of yearly schedules and clock drift). On `reconfigure(view)`: cancel all timers, rearm from scratch.
- **NEW** Missed ticks on restart are silently skipped (next tick computed from `now`). No missed-tick lifecycle event, no `lastFiredAt` persistence.
- **NEW** Trigger-UI "Run now" button for cron triggers (no form). Clicking dispatches `executor.invoke` with the empty payload; cron source is untouched, scheduled timers keep running in parallel.
- **MODIFIED** `Trigger` union widens to `HttpTrigger | CronTrigger`.

## Capabilities

### New Capabilities

- `cron-trigger`: Native cron trigger — SDK factory contract, per-trigger setTimeout-chain scheduler, reconfigure semantics, DST behavior inherited from `cron-parser` (skipped local times resolve forward; repeated local times fire once), multi-instance caveat (single runtime instance assumed; horizontal scaling requires leader election — out of scope for v1), runQueue sharing with other triggers in the same workflow (unbounded; cron ticks enqueue behind slow handlers).

### Modified Capabilities

- `triggers`: Extend the `Trigger` umbrella union from `HttpTrigger` to `HttpTrigger | CronTrigger`. The existing spec already anticipates this in its "Trigger union grows by union member" scenario — this change delivers it.
- `sdk`: Add `CRON_TRIGGER_BRAND`, `cronTrigger(config)` factory, `isCronTrigger(value)` type guard, and the `CronTrigger` type. Schedule field is typed via `ts-cron-validator` for compile-time validation.
- `vite-plugin`: Brand-based discovery extended to `CRON_TRIGGER_BRAND`. No new AST transform required: the SDK factory defaults `tz` at construction time and the plugin (which already evaluates bundles in Node to walk branded exports) reads the resolved `tz` off each cron-trigger export for manifest emission — the same pattern used today for `HttpTrigger.path`.
- `workflow-manifest`: Add cron trigger descriptor shape `{ name, type: "cron", schedule, tz, inputSchema, outputSchema }`. Extend `ManifestSchema` to accept the `cron` discriminant. Add host-side Ajv validation keyword for IANA timezones.
- `trigger-ui`: List cron triggers alongside HTTP triggers on `/trigger/<tenant>/<workflow>/`. Render a "Run now" button (no payload form) for cron triggers; clicking POSTs to the existing trigger-UI handler which dispatches `executor.invoke` with empty payload `{}`.

## Impact

- **SDK** (`packages/sdk/src/index.ts`): new brand, factory, type guard; new `ts-cron-validator` dev/peer dependency for type-level cron validation.
- **SDK plugin** (`packages/sdk/src/plugin/`): new brand discovery, AST tz-injection transform.
- **Runtime** (`packages/runtime/src/triggers/cron.ts` + `cron.test.ts`): new `TriggerSource<"cron">`; new `cron-parser` runtime dependency.
- **Runtime registry/upload** (`packages/runtime/src/api/upload.ts`, `packages/runtime/src/workflow-registry.ts`): extended Ajv keyword for IANA tz; manifest schema accepts cron descriptors.
- **Runtime UI** (`packages/runtime/src/ui/trigger/middleware.ts`, `page.ts`): list cron triggers; render "Run now" for cron; dispatch with empty payload.
- **Core** (`packages/core/`): manifest types extended with cron descriptor.
- **SECURITY.md**: no new threats. Cron triggers reuse `/api/triggers/run/*` which is already behind oauth2-proxy + `isMember`. No new NEVERs; existing §4 tenant-isolation and forward-auth invariants cover the new kind. A short note in §3 / §4 confirms cron triggers are not a new public ingress surface (they have no external caller).
- **No breaking manifest change**: existing HTTP-only bundles remain valid; the manifest schema becomes a discriminated union on `triggers[].type`.
- **Single-instance assumption reinforced**: the cron source fires on the process that holds the schedule; horizontal scaling is out of scope for this change.
