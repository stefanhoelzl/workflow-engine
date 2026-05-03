## ADDED Requirements

### Requirement: defineQueue authoring primitive

The SDK SHALL export a `defineQueue` factory that accepts `{name?, schema}` and returns a brand-tagged `Queue<T>` handle whose only members are `put(item: T) => Promise<void>` and `get() => Promise<T | undefined>`. The handle SHALL carry `Symbol.for("@workflow-engine/queue")` (`QUEUE_BRAND`) for build-time discovery. The SDK SHALL also export a matching `isQueue` type guard. `T` SHALL be inferred via `z.infer<typeof schema>`. The `name` argument SHALL be optional: when omitted, the workflow build pipeline derives the queue's name from the export identifier (matching the existing rule for `action` and `*Trigger`); when provided, the explicit value overrides the export name. The runtime identity used for the on-disk path is the resolved name (explicit or derived).

#### Scenario: Author declares and uses a queue with derived name

- **WHEN** an author writes `export const jobs = defineQueue({schema: z.object({url: z.string().url()})});`
- **AND** within a trigger handler calls `await jobs.put({url: "https://example.com"})`
- **THEN** the manifest SHALL carry the queue under `name = "jobs"` (derived from the export identifier)
- **AND** `await jobs.get()` SHALL resolve with `{url: "https://example.com"}` on the next call

#### Scenario: Explicit name overrides export identifier

- **WHEN** an author writes `export const jobs = defineQueue({name: "jobsV2", schema});`
- **THEN** the manifest entry SHALL carry `name = "jobsV2"`
- **AND** the on-disk file SHALL be `<root>/queues/<owner>/<repo>/<workflow>/jobsV2.ndjson`

#### Scenario: Brand symbol enables build-time discovery

- **WHEN** the workflow build pipeline inspects an exported value
- **AND** the value carries `QUEUE_BRAND`
- **THEN** the pipeline SHALL treat the export as a queue declaration
- **AND** add a `{name, schema}` entry to the workflow's manifest

#### Scenario: isQueue type guard

- **WHEN** `isQueue(value)` is called on a brand-tagged queue handle
- **THEN** it SHALL return `true`
- **AND** narrow the value's type to `Queue<unknown>` for the caller

### Requirement: defineQueue handle is immutable

The handle returned by `defineQueue` SHALL be frozen. Authors MUST NOT be able to replace `put` or `get` after construction; doing so SHALL throw under strict mode or be a silent no-op outside it.

#### Scenario: Attempt to overwrite put

- **GIVEN** a queue handle `const q = defineQueue({...})`
- **WHEN** an author writes `q.put = somethingElse`
- **THEN** the assignment SHALL throw `TypeError` under strict mode (which the sandbox runs by default)
