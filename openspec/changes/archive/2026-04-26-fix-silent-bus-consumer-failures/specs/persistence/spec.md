## MODIFIED Requirements

### Requirement: Persistence consumer implements BusConsumer

The persistence consumer SHALL implement the `BusConsumer` interface. It SHALL be created via a factory function that accepts a `StorageBackend` instance and returns an object with `name`, `strict`, and `handle`.

The persistence consumer SHALL declare `name === "persistence"` and `strict === true`. The `strict` flag is load-bearing: persistence is the durability boundary for invocation events, so a thrown rejection from `handle` is a runtime-fatal condition. Per the event-bus contract (see `event-bus/spec.md § Requirement: EventBus interface`), the bus logs `runtime.fatal { reason: "bus-strict-consumer-failed", … }` and terminates the process when a strict consumer throws — callers of `bus.emit` (executor, recovery) do not see the rejection because `bus.emit` never resolves under that path.

#### Scenario: Factory creates persistence consumer with strict tier

- **GIVEN** a `StorageBackend` instance
- **WHEN** the persistence factory is called with the backend
- **THEN** the returned object implements `BusConsumer` (`name`, `strict`, `handle`)
- **AND** the returned object's `name` SHALL equal `"persistence"`
- **AND** the returned object's `strict` SHALL equal `true`

## ADDED Requirements

### Requirement: Pending write failure is fatal

When `backend.write("pending/{id}/{seq}.json", …)` rejects, the persistence consumer SHALL re-throw the underlying error from `handle`. The accumulator entry for the invocation SHALL NOT be updated (matching the existing rule that the accumulator updates only after the corresponding pending write succeeds).

A pending-write rejection means the event is lost from the durability layer (it never landed on disk and the in-memory accumulator does not have it either, so the eventual archive write would also be incomplete). Per the event-bus strict-consumer contract (see `event-bus/spec.md § Requirement: EventBus interface`), this throw causes the bus to log `runtime.fatal { reason: "bus-strict-consumer-failed", consumer: "persistence", … }` and terminate the process. Next-startup recovery's existing orphan-`pending/` reconciliation closes the affected invocation as `trigger.error` (or as `archive-cleanup` if the prior process happened to write the archive but not clean up).

This requirement makes the existing behaviour explicit; it is implicitly required today by the rule that the accumulator updates only after the pending write succeeds, but the failure consequences were never spelled out.

#### Scenario: Pending write rejection re-throws and leaves accumulator untouched

- **GIVEN** the persistence consumer is handling event seq=3 for invocation `evt_a` with seqs 0..2 already in the accumulator
- **WHEN** `backend.write("pending/evt_a/000003.json", …)` rejects with `Error("storage offline")`
- **THEN** the consumer's `handle` SHALL re-throw `Error("storage offline")`
- **AND** the accumulator entry for `evt_a` SHALL still hold exactly seqs 0..2 (no entry for seq=3)
- **AND** under the bus's strict-consumer contract, this rethrow SHALL trigger the bus's fatal-exit path (`runtime.fatal` log + `process.exit(1)`)
