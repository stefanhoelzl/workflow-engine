## MODIFIED Requirements

### Requirement: Self-contained event files

Each event file SHALL contain all event fields (`id`, `type`, `payload`, `targetAction`, `correlationId`, `parentEventId`, `createdAt`) plus a `state` field. Files SHALL be independently useful for auditing without needing other files.

The stored event format SHALL be defined as a Zod schema (`StoredEventSchema`) derived from `EventSchema.extend({ state: z.enum(["pending", "done", "failed"]) })`. Deserialization from disk SHALL use `StoredEventSchema.parse()`. Serialization to disk SHALL use `JSON.stringify()`.

#### Scenario: Event file contains full data

- **WHEN** an event is enqueued
- **THEN** the written file SHALL contain all event properties and `"state": "pending"`
- **AND** `createdAt` SHALL be serialized as an ISO 8601 string

#### Scenario: Event file is parsed from disk

- **GIVEN** a JSON file on disk with `createdAt` as an ISO 8601 string and a `state` field
- **WHEN** the file is read and parsed via `StoredEventSchema.parse()`
- **THEN** the resulting object SHALL have `createdAt` as a `Date` and a valid `state`
