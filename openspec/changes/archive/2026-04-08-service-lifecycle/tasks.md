## 1. Service interface and directory structure

- [x] 1.1 Create `src/services/index.ts` with the `Service` interface (`start(): Promise<void>`, `stop(): Promise<void>`)

## 2. EventQueue AbortSignal support

- [x] 2.1 Add optional `signal?: AbortSignal` parameter to `dequeue()` in the `EventQueue` interface (`src/event-queue/index.ts`)
- [x] 2.2 Update `InMemoryEventQueue.dequeue()` to handle AbortSignal: register abort listener that removes the waiter and rejects with AbortError, clean up listener on normal resolve
- [x] 2.3 Add tests for AbortSignal behavior in `in-memory.test.ts`: abort rejects with AbortError, waiter is removed on abort, normal resolve cleans up listener

## 3. Scheduler factory

- [x] 3.1 Create `src/services/scheduler.ts` with `createScheduler()` factory returning `Service` — closure-based, owns AbortController, loop catches AbortError to exit cleanly
- [x] 3.2 Move and update tests from `src/scheduler/scheduler.test.ts` to `src/services/scheduler.test.ts` — adapt for factory API, remove dummy-event-to-unblock workaround
- [x] 3.3 Delete `src/scheduler/` directory

## 4. Server factory

- [x] 4.1 Create `src/services/server.ts` with `createApp()` (returns Hono) and `createServer(port, ...middlewares)` (returns Service) — start wraps `serve()` with error/listening/close handling, stop wraps `server.close()` in a promise
- [x] 4.2 Move and update tests from `src/server.test.ts` to `src/services/server.test.ts` — tests use `createApp` directly
- [x] 4.3 Delete `src/server.ts`

## 5. Entrypoint restructure

- [x] 5.1 Rewrite `main.ts` as `async function main()`: create services via factories, attach `.catch(onError)` to both `start()` calls, register SIGINT/SIGTERM with double-signal guard, shutdown calls `Promise.allSettled` on both `stop()` methods, log and `process.exit()`
- [x] 5.2 Update all internal imports that reference the old `scheduler/` or `server` paths

## 6. Verification

- [x] 6.1 Run `pnpm lint`, `pnpm check`, and `pnpm test` — all pass
