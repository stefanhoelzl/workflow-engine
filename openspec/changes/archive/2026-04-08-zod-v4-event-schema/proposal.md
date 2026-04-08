## Why

The `Event` type is defined as a plain TypeScript interface, and `FileSystemEventQueue` duplicates it as a separate `StoredEvent` interface to handle JSON serialization differences (`Date` vs `string`, `undefined` vs `null`). This means two types that say almost the same thing, plus manual `serializeEvent()`/`deserializeEvent()` functions. Upgrading Zod from v3 to v4 and defining `Event` as a Zod schema eliminates this duplication — `StoredEventSchema` becomes `EventSchema.extend({ state })`, and parsing/validation is handled by Zod. Zod v4's `exactOptional` support is required because the project uses `exactOptionalPropertyTypes: true`.

## What Changes

- **BREAKING**: Upgrade `zod` dependency from `^3.25.0` to `^4.0.0` in `@workflow-engine/sdk`
- Add `zod` `^4.0.0` as a dependency of `@workflow-engine/runtime`
- Replace `Event` interface with `EventSchema` (Zod v4 schema) in `event-queue/index.ts`, exporting both the schema and derived `Event` type
- Replace `StoredEvent` interface, `serializeEvent()`, and `deserializeEvent()` in `fs-queue.ts` with `StoredEventSchema = EventSchema.extend({ state })` and use `.parse()` / `JSON.stringify()`
- Update SDK imports from `"zod"` to `"zod/v4"` (Zod v4 API)

## Capabilities

### New Capabilities

_None_

### Modified Capabilities

- `event-queue`: Event type definition changes from a plain interface to a Zod-derived type. The shape is identical; only the definition mechanism changes.
- `sdk`: Zod import path changes from `"zod"` (v3 API) to `"zod/v4"` (v4 API). Re-exported `z` namespace changes.
- `fs-queue`: StoredEvent type replaced with Zod schema derived from EventSchema. Serialization/deserialization simplified.

## Impact

- `packages/sdk/package.json` — Zod version bump
- `packages/sdk/src/index.ts` — import path change (`zod` → `zod/v4`)
- `packages/runtime/package.json` — new `zod` dependency
- `packages/runtime/src/event-queue/index.ts` — `Event` interface → `EventSchema` + derived type
- `packages/runtime/src/event-queue/fs-queue.ts` — remove `StoredEvent`, `serializeEvent`, `deserializeEvent`; add `StoredEventSchema`
- All existing consumers of `Event` type are unaffected (same shape via `z.infer`)
