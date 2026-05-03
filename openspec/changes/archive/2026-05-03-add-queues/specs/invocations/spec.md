## ADDED Requirements

### Requirement: queue.put and queue.get system event names

The invocation event stream SHALL accept `system.request`, `system.response`, and `system.error` events whose `name` field is `"queue.put"` or `"queue.get"`. These events SHALL ride the existing reserved `system.*` prefix per `SECURITY.md` §2 R-7 (no new event prefix introduced). Each `put` or `get` host bridge call SHALL emit one `system.request` and one `system.response`-or-`system.error` pair. Cancelled calls (e.g., run cancelled mid-call) SHALL emit a `system.exception` per the existing single-leaf pattern.

#### Scenario: Successful put emits request and response

- **GIVEN** a workflow handler calls `await q.put(item)` and the bridge succeeds
- **WHEN** event recording completes
- **THEN** the event stream SHALL contain a `system.request` with `name = "queue.put"` and an `input` carrying the item
- **AND** a paired `system.response` with the same `name` and matching `ref`
- **AND** no `system.error` for that call

#### Scenario: Failed put emits request and error

- **GIVEN** a workflow handler calls `await q.put(item)` and the host bridge throws `QueueItemTooLarge`
- **WHEN** event recording completes
- **THEN** the event stream SHALL contain a `system.request` with `name = "queue.put"`
- **AND** a paired `system.error` with `name = "queue.put"`, `code = "queue.itemTooLarge"`, and a `message` field
- **AND** no `system.response` for that call

#### Scenario: Get-time schema mismatch carries dropped item

- **GIVEN** a `get` whose popped item fails the current schema
- **WHEN** the bridge throws `QueueSchemaMismatch`
- **THEN** the emitted `system.error` SHALL carry `name = "queue.get"`, `code = "queue.schemaMismatch"`, and the dropped item under a payload field accessible to operator forensics

### Requirement: Queue error codes

The following typed error codes SHALL be produced by the queue plugin and SHALL appear on the `code` field of `InvocationEventError` for queue-related failures:

- `queue.itemTooLarge` — `put` rejected; item exceeded the per-item byte cap
- `queue.full` — `put` rejected; queue at the per-queue depth cap
- `queue.schemaMismatch` — `put` or `get` rejected; item failed schema validation (on `get`, the item has been removed from the queue and is carried in the error payload)
- `queue.gone` — `put` or `get` against a queue file that no longer exists (orphaned in-flight invocation after declaration removal, or symlink-at-path with `O_NOFOLLOW` failure)
- `queue.notDeclared` — `put` or `get` against a queue name not in the per-sandbox declared list

#### Scenario: Error codes are stable wire identifiers

- **WHEN** any of the above failures cross the host bridge
- **THEN** the `code` field SHALL be exactly the dotted string above
- **AND** the `code` SHALL be stable across runtime versions (treated as a wire contract)
