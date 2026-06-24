## ADDED Requirements

### Requirement: Worker→main host-call trust boundary

The worker→main host-call channel SHALL be treated as a trust boundary, given as explicit treatment in `SECURITY.md §2`.

Handler arguments SHALL be validated on the main thread before the handler accesses any host singleton. Each handler SHALL be scoped to the sandbox's `(owner, workflow)` — the scope SHALL be captured when the runtime builds the per-sandbox `hostHandlers` map and SHALL NOT be widened by caller-supplied arguments. A handler SHALL fail closed if asked to operate outside its `(owner, workflow)` scope.

`callHost` SHALL NOT be reachable by guest code; only plugin worker-side code may issue host-calls. Adding a new host method SHALL require the same explicit security treatment as adding a new sandbox global or public guest-function descriptor.

#### Scenario: Args validated before any singleton access

- **GIVEN** a host method backed by a main-thread singleton
- **WHEN** a host-call arrives with args that fail the method's contract
- **THEN** validation SHALL reject on the main side before the singleton is touched

#### Scenario: Handler cannot cross its owner/workflow scope

- **GIVEN** a handler built for sandbox `(ownerA, workflowA)`
- **WHEN** a host-call supplies arguments that name `ownerB`
- **THEN** the handler SHALL remain scoped to `(ownerA, workflowA)` and SHALL NOT read or write `ownerB` data

#### Scenario: Guest code cannot issue host-calls

- **GIVEN** guest workflow code attempting to invoke a host method directly
- **WHEN** it tries to reach the host-call channel
- **THEN** no host-call primitive SHALL be reachable from guest scope
