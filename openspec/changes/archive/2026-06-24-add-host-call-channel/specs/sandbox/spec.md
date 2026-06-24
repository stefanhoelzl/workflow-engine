## ADDED Requirements

### Requirement: Host-call channel protocol

The sandbox worker protocol SHALL provide a worker→main **host-call channel** that is distinct from the one-way event stream, the `log` messages, and the `done` run result. This channel is distinct from the existing guest↔worker bridge RPC; the term "RPC" SHALL NOT be used for it in code or docs.

`WorkerToMain` SHALL include `{ type: "host-call-request"; id: number; method: string; args: unknown[] }` and `MainToWorker` SHALL include `{ type: "host-call-response"; id: number; ok: boolean; result?: unknown; error?: SerializedError }`. The `id` SHALL be a monotonic identifier minted per run on the worker; the main thread SHALL echo it unchanged on the response so the worker can correlate it to a pending call.

The channel SHALL be asynchronous over the existing worker port. It SHALL NOT use `SharedArrayBuffer` or `Atomics`. Arguments and results crossing the channel SHALL be JSON-serializable per the existing JSON-only host/sandbox boundary.

#### Scenario: Request/response round-trip

- **GIVEN** a worker plugin handler that issues a host-call for method `"x"` with args `[1, 2]`
- **WHEN** the main side resolves the call with the value `3`
- **THEN** the worker SHALL receive a `host-call-response` with the matching `id`, `ok: true`, and `result: 3`
- **AND** the handler's awaited call SHALL resolve to `3`

#### Scenario: Error response surfaces as a throw

- **GIVEN** a host-call whose main-side handler rejects with an error
- **WHEN** the `host-call-response` arrives with `ok: false` and a `SerializedError`
- **THEN** the worker SHALL reject the corresponding pending call with the deserialized error

### Requirement: hostHandlers factory option

The `sandbox()` factory and `factory.create()` SHALL accept an optional `hostHandlers` map of shape `{ [method: string]: (args: unknown[]) => Promise<unknown> }`. This is a composition-time concern and is in addition to (not a replacement for) the existing prohibition on top-level `methods`, `onEvent`, `logger`, and `fetch` options.

On receiving a `host-call-request`, the sandbox main side SHALL look up `method` in `hostHandlers`. If present, it SHALL `await` the handler and post `host-call-response { ok: true, result }`, or `{ ok: false, error }` if the handler throws. If absent, it SHALL post `{ ok: false, error }` whose error names the unknown method. The sandbox core SHALL NOT interpret method names or payloads beyond this routing.

Omitting `hostHandlers` SHALL be equivalent to providing an empty map: every host-call SHALL reject as an unknown method.

#### Scenario: Registered handler is invoked

- **GIVEN** a sandbox constructed with `hostHandlers` containing `"echo"`
- **WHEN** a worker plugin issues a host-call for `"echo"`
- **THEN** the `"echo"` handler SHALL be invoked with the call's args
- **AND** its resolved value SHALL be returned to the worker as `ok: true`

#### Scenario: Unknown method rejects

- **GIVEN** a sandbox whose `hostHandlers` has no `"missing"` entry
- **WHEN** a worker plugin issues a host-call for `"missing"`
- **THEN** the main side SHALL post `host-call-response { ok: false, error }` whose error names `"missing"`
- **AND** the worker's awaited call SHALL reject

#### Scenario: No hostHandlers provided

- **GIVEN** a sandbox constructed without a `hostHandlers` option
- **WHEN** a worker plugin issues any host-call
- **THEN** the call SHALL reject as an unknown method

### Requirement: Host-call run-end rejection

At the end of each run, the worker SHALL reject any still-pending `callHost` promises and clear its pending-call map, mirroring the dispose-time treatment of in-flight bridge calls. This SHALL happen before the VM snapshot restore so that no `host-call-response` is correlated to a pending call across runs.

Main-side handlers already dispatched SHALL run to completion; their responses arriving after the run has ended SHALL be dropped on the worker side. Any side effect such a handler already performed on the main side remains committed.

#### Scenario: Pending host-call rejected at run end

- **GIVEN** a run whose handler issued a host-call it did not await to completion
- **WHEN** the run ends
- **THEN** the pending `callHost` promise SHALL be rejected on the worker side
- **AND** the worker's pending-call map SHALL be empty before the next run executes

#### Scenario: Late response does not leak across runs

- **GIVEN** a host-call still in flight on the main side when run A ends
- **WHEN** its `host-call-response` arrives after run B has started
- **THEN** the response SHALL be dropped and SHALL NOT resolve any call in run B
