## MODIFIED Requirements

### Requirement: defineQueue authoring primitive

The SDK SHALL export a `defineQueue` factory that accepts `{name?, schema}` and returns a brand-tagged `Queue<T>` handle whose members are `put(item: T, key?: string) => Promise<void>` and `get(key?: string) => Promise<T | undefined>`. The optional `key` names a partition **within** the queue: `put(item, key)` enqueues into that partition and `get(key)` pops FIFO from that partition only, never observing or removing items under another key. An omitted `key` SHALL resolve to the unkeyed partition (the empty string `''`); the SDK guest shim is the sole place that materializes this default, so a concrete `string` key crosses the host bridge on every call. `get()` SHALL be equivalent to `get('')`. The handle SHALL carry `Symbol.for("@workflow-engine/queue")` (`QUEUE_BRAND`) for build-time discovery. The SDK SHALL also export a matching `isQueue` type guard. `T` SHALL be inferred via `z.infer<typeof schema>`. The `name` argument SHALL be optional: when omitted, the workflow build pipeline derives the queue's name from the export identifier (matching the existing rule for `action` and `*Trigger`); when provided, the explicit value overrides the export name. The runtime identity used for storage is the resolved name (explicit or derived); the `key` is orthogonal to the queue's identity and is never part of the manifest.

#### Scenario: Author declares and uses a queue with derived name

- **WHEN** an author writes `export const jobs = defineQueue({schema: z.object({url: z.string().url()})});`
- **AND** within a trigger handler calls `await jobs.put({url: "https://example.com"})`
- **THEN** the manifest SHALL carry the queue under `name = "jobs"` (derived from the export identifier)
- **AND** `await jobs.get()` SHALL resolve with `{url: "https://example.com"}` on the next call

#### Scenario: Keyed put and get address one partition

- **WHEN** an author calls `await jobs.put({url: "https://a"}, "alice")` and `await jobs.put({url: "https://b"}, "bob")`
- **THEN** `await jobs.get("alice")` SHALL resolve with `{url: "https://a"}`
- **AND** `await jobs.get("bob")` SHALL resolve with `{url: "https://b"}`
- **AND** `await jobs.get()` (unkeyed) SHALL resolve with `undefined` (neither item is in the unkeyed partition)

#### Scenario: Explicit name overrides export identifier

- **WHEN** an author writes `export const jobs = defineQueue({name: "jobsV2", schema});`
- **THEN** the manifest entry SHALL carry `name = "jobsV2"`
- **AND** the resolved name `jobsV2` SHALL be used as the `queue` column value in `queue_items`

#### Scenario: Brand symbol enables build-time discovery

- **WHEN** the workflow build pipeline inspects an exported value
- **AND** the value carries `QUEUE_BRAND`
- **THEN** the pipeline SHALL treat the export as a queue declaration
- **AND** add a `{name, schema}` entry to the workflow's manifest

#### Scenario: isQueue type guard

- **WHEN** `isQueue(value)` is called on a brand-tagged queue handle
- **THEN** it SHALL return `true`
- **AND** narrow the value's type to `Queue<unknown>` for the caller
