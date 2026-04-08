## 1. InMemoryEventQueue constructor seeding

- [x] 1.1 Update `InMemoryEventQueue` constructor to accept optional `Event[]` parameter that seeds initial pending entries
- [x] 1.2 Add tests for constructor seeding (with events, without events, seeded events are dequeueable)

## 2. FileSystemEventQueue core implementation

- [x] 2.1 Create `fs-queue.ts` with `FileSystemEventQueue` class extending `InMemoryEventQueue`
- [x] 2.2 Implement atomic write utility (write to `.tmp`, rename to final path)
- [x] 2.3 Implement global counter (in-memory monotonic counter, `<counter>_evt_<uuid>.json` naming)
- [x] 2.4 Implement `enqueue()` — atomic-write event file to `pending/`, then `super.enqueue()`
- [x] 2.5 Implement `ack()`/`fail()` — write terminal file, `super.ack()`/`super.fail()`, archive all event files (lowest counter first)
- [x] 2.6 Implement `create()` static factory — ensure directories, recover counter from max filename across `pending/` and `archive/`, recover events from `pending/`, return initialized instance

## 3. Crash recovery

- [x] 3.1 Implement recovery logic: group files by event ID, read highest serial, requeue pending or complete interrupted archives
- [x] 3.2 Test: pending events in `pending/` are recovered and dequeueable after restart
- [x] 3.3 Test: interrupted archive (terminal file in `pending/`) is completed on startup
- [x] 3.4 Test: `.tmp` files in `pending/` are ignored during recovery

## 4. Shared contract tests

- [x] 4.1 Extract behavioral tests from `in-memory.test.ts` into a shared contract test suite
- [x] 4.2 Run shared contract tests against `InMemoryEventQueue`
- [x] 4.3 Run shared contract tests against `FileSystemEventQueue` (using temp directories)

## 5. Integration

- [x] 5.1 Export `FileSystemEventQueue` from the event-queue module
- [x] 5.2 Update `main.ts` to select queue backend based on `EVENT_QUEUE_PATH` env var: if set, use `FileSystemEventQueue.create(path)`; if not, use `InMemoryEventQueue`
