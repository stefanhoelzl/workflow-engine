## 1. Upgrade Zod

- [x] 1.1 Update `packages/sdk/package.json` to `"zod": "^4.0.0"` and run `pnpm install`
- [x] 1.2 Update SDK imports from `"zod"` to `"zod"` (v4 API — verify import works with new version)
- [x] 1.3 Add `"zod": "^4.0.0"` to `packages/runtime/package.json` and run `pnpm install`
- [x] 1.4 Verify `pnpm check`, `pnpm lint`, and `pnpm test` pass after upgrade

## 2. EventSchema

- [x] 2.1 Replace `Event` interface in `event-queue/index.ts` with `EventSchema` using Zod v4 (`z.exactOptional` for `targetAction`/`parentEventId`, `z.coerce.date()` for `createdAt`)
- [x] 2.2 Export `EventSchema` and derived `type Event = z.infer<typeof EventSchema>` from the module
- [x] 2.3 Verify all existing consumers of `Event` type compile without changes

## 3. StoredEventSchema

- [x] 3.1 Replace `StoredEvent` interface, `StoredEventState` type, `serializeEvent()`, and `deserializeEvent()` in `fs-queue.ts` with `StoredEventSchema = EventSchema.extend({ state })`
- [x] 3.2 Update deserialization to use `StoredEventSchema.parse(JSON.parse(content))`
- [x] 3.3 Update serialization to use `JSON.stringify({ ...event, state }, null, 2)`
- [x] 3.4 Verify all fs-queue tests pass (including crash recovery tests)

## 4. Verification

- [x] 4.1 Run `pnpm check`, `pnpm lint`, `pnpm test` — all must pass
