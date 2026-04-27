## MODIFIED Requirements

### Requirement: EventStore implements BusConsumer

The EventStore SHALL implement the `BusConsumer` interface. It SHALL be created via a factory function `createEventStore(options?: { logger? }): EventStore` that eagerly creates an in-memory DuckDB instance, runs DDL, and returns an object with `name`, `strict`, `handle()`, a `query(scopes)` method, and a `ping()` method.

The EventStore SHALL declare `name === "event-store"` and `strict === false`. Per the event-bus contract (see `event-bus/spec.md § Requirement: EventBus interface`), best-effort consumer failures are logged as `bus.consumer-failed` and the bus continues to subsequent consumers — the runtime is not terminated. The durability boundary is owned by the persistence consumer, not by the in-memory index; lost EventStore inserts can be reconstructed by reading the archive on next boot.

#### Scenario: Factory creates EventStore

- **WHEN** `createEventStore()` is called
- **THEN** the returned object implements `BusConsumer` (`name`, `strict`, `handle`)
- **AND** exposes a `query(scopes: ReadonlyArray<{owner: string, repo: string}>)` method (returns a scope-bound read-only `SelectQueryBuilder`)
- **AND** exposes a `ping(): Promise<void>` method
- **AND** the in-memory DuckDB instance is ready for queries

#### Scenario: EventStore declares best-effort tier

- **GIVEN** an EventStore instance returned from `createEventStore()`
- **THEN** its `name` SHALL equal `"event-store"`
- **AND** its `strict` SHALL equal `false`
