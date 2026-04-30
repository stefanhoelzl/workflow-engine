# E2E Test Framework Specification

## Purpose

Define the end-to-end test framework `@workflow-engine/tests`, a private workspace package that spawns the runtime as a child process and exercises it via HTTP, persistence, mocks, and (for UI flows) Playwright. The framework's only public test-author surface is `describe`, `test`, `expect`; tests are expressed as a chainable Scenario DSL whose body is run once under vitest. The framework ships exactly 19 end-to-end tests that each cover one invariant unreachable by unit or in-process integration tests.
## Requirements
### Requirement: Test package layout

A new package `@workflow-engine/tests` SHALL exist at `packages/tests/` containing the framework code, mock implementations, and end-to-end test files.

#### Scenario: Package exists and is private

- **WHEN** inspecting the workspace
- **THEN** `packages/tests/package.json` SHALL exist with `"private": true` and name `"@workflow-engine/tests"`
- **AND** the package SHALL declare `vitest`, `@workflow-engine/runtime`, `@workflow-engine/sdk`, `@workflow-engine/core` as dependencies

#### Scenario: Package has its own vitest project

- **WHEN** inspecting `packages/tests/`
- **THEN** a `vitest.config.ts` SHALL exist defining a vitest project named `tests`
- **AND** test files SHALL live under `packages/tests/test/**/*.test.ts`

### Requirement: Test entrypoint script

The repository root `package.json` SHALL define a `test:e2e` script that builds all workspace packages and then runs the e2e vitest project.

#### Scenario: Running e2e tests

- **WHEN** a developer runs `pnpm test:e2e`
- **THEN** `pnpm build` SHALL run first (recursive workspace build)
- **AND** then `vitest run --project tests` SHALL run
- **AND** the script SHALL exit non-zero if either step fails

#### Scenario: E2E excluded from validate

- **WHEN** a developer runs `pnpm validate`
- **THEN** the e2e suite SHALL NOT run
- **AND** `pnpm test` SHALL NOT discover or execute files under `packages/tests/test/`

### Requirement: Public test-author surface

The test framework SHALL expose exactly three public exports from `@workflow-engine/tests`: `describe`, `test`, `expect`. No other top-level exports SHALL exist.

#### Scenario: Three public exports

- **WHEN** a test file imports from `@workflow-engine/tests`
- **THEN** the only available exports SHALL be `describe`, `test`, `expect`

#### Scenario: No imperative escape hatch

- **WHEN** a test author needs to express a scenario
- **THEN** the only available form SHALL be `test(name, s => s.chain())`
- **AND** no `test.raw`, `test.browser`, or app-handle direct method API SHALL be exposed

### Requirement: Describe wraps spawn lifecycle

The `describe(name, body)` function SHALL spawn one runtime child per describe block and tear it down at end-of-describe.

#### Scenario: One child per describe

- **WHEN** a describe block executes
- **THEN** exactly one `node packages/runtime/dist/main.js` subprocess SHALL be spawned at `beforeAll`
- **AND** the child SHALL be killed at `afterAll`

#### Scenario: Custom env per describe

- **WHEN** `describe(name, {env: {KEY: "value"}}, body)` is called
- **THEN** the spawned child's environment SHALL include the provided env vars
- **AND** these vars SHALL override any defaults

#### Scenario: Default env

- **WHEN** `describe(name, body)` is called without env opts
- **THEN** the spawned child SHALL receive: `PORT` (random free port), `PERSISTENCE_PATH` (tmp dir), `SECRETS_PRIVATE_KEYS` (fresh keypair), `LOCAL_DEPLOYMENT=1`, `AUTH_ALLOW=local:dev,local:alice:acme,local:bob:other`, `LOG_LEVEL=info`

### Requirement: Test wraps scenario chain

The `test(name, body)` function SHALL accept a body that returns a Scenario chain and SHALL invoke the chain's `.run()` after the body returns.

#### Scenario: Chain body

- **WHEN** `test("name", s => s.workflow(...).webhook(...).expect(...))` is called
- **THEN** the framework SHALL call `.run()` on the returned scenario
- **AND** the test SHALL pass if `.run()` resolves
- **AND** the test SHALL fail if `.run()` rejects

#### Scenario: Body must return chained scenario

- **WHEN** the body returns something other than the chained scenario
- **THEN** the test SHALL fail with a clear error message

### Requirement: Scenario chain DSL

The Scenario interface SHALL expose exactly nine chainable methods: `workflow`, `upload`, `fetch`, `webhook`, `manual`, `waitForEvent`, `expect`, `sigterm`, `sigkill`, `browser`. Every method SHALL return `this` synchronously.

#### Scenario: Chain methods return this

- **WHEN** any chain method is called on a Scenario
- **THEN** it SHALL return the same Scenario instance
- **AND** the return type SHALL be `this`, not `Promise<this>`

#### Scenario: Lazy execution

- **WHEN** chain methods are called
- **THEN** no I/O SHALL occur during chain construction
- **AND** all queued steps SHALL execute in order when `.run()` is called by the test wrapper

### Requirement: Workflow step queues fixture sources

The `.workflow(name, source, opts?)` method SHALL queue a workflow source for compilation and upload. Multiple `.workflow()` calls SHALL be permitted before an `.upload()` flush.

#### Scenario: Single workflow

- **WHEN** `.workflow("a", source)` is called once
- **THEN** at the next implicit or explicit upload flush, one upload SHALL be POSTed to `/api/workflows/<owner>/<repo>` containing workflow `a`
- **AND** owner SHALL default to `"dev"` and repo to `"e2e"` when not specified

#### Scenario: Multiple workflows in one upload

- **WHEN** `.workflow("a", srcA).workflow("b", srcB)` is called with the same `(owner, repo)`
- **THEN** both workflows SHALL be bundled into one upload to `/api/workflows/<owner>/<repo>`

#### Scenario: Workflows under different owner/repo

- **WHEN** `.workflow("a", srcA, {owner: "x", repo: "y"}).workflow("b", srcB, {owner: "x", repo: "z"})` is called
- **THEN** at the next flush, two separate uploads SHALL be POSTed (one to `x/y`, one to `x/z`)

### Requirement: Upload flush

The `.upload()` method SHALL flush all queued workflows as one upload per `(owner, repo)` group; when not called explicitly, the framework SHALL flush queued workflows automatically before any subsequent step that requires the workflows to be registered.

#### Scenario: Explicit upload between steps

- **WHEN** `.workflow(...).upload().workflow(...).upload()` is called
- **THEN** two separate flushes SHALL occur in order
- **AND** `state.uploads` SHALL contain two entries

#### Scenario: Implicit upload before fire

- **WHEN** `.workflow(...).webhook(...)` is called without an explicit `.upload()`
- **THEN** the framework SHALL upload the queued workflows before the webhook fires

### Requirement: Inline source fixtures

The `source` parameter to `.workflow()` SHALL be a complete TypeScript module string. The framework SHALL compile it via `build()` from `@workflow-engine/sdk/cli` and upload via `upload()` from the same package.

#### Scenario: Plain template literal

- **WHEN** a test passes `\`import {defineWorkflow, ...} from '@workflow-engine/sdk'; ...\`` as source
- **THEN** the framework SHALL write it to a temp `.ts` file, run `build()` on the temp directory, and upload the result

#### Scenario: Build failure surfaces

- **WHEN** the inline source fails to compile (TypeScript error, missing import, etc.)
- **THEN** the test SHALL fail with the build error visible in the diagnostic output

### Requirement: Fixture build cache

The framework SHALL maintain an on-disk cache of compiled fixture bundles at `node_modules/.cache/wfe-tests/<key>/` where `key = sha256([source, name, owner, repo])`.

#### Scenario: Cache hit

- **WHEN** a fixture with a previously-seen source+name+owner+repo combination is encountered
- **THEN** the framework SHALL reuse the cached bundle without re-running `build()`

#### Scenario: Cache invalidation on SDK or core change

- **GIVEN** an existing cache directory with a `.build-hash` sentinel
- **WHEN** the SDK or core dist content hash differs from the sentinel
- **THEN** at `globalSetup` the framework SHALL wipe `node_modules/.cache/wfe-tests/*`
- **AND** write a new `.build-hash` file containing the current `sha256(sdkDist + coreDist)`

#### Scenario: Cache concurrency safety

- **WHEN** two workers race to write the same cache key
- **THEN** the framework SHALL use atomic `mkdtemp` + `rename` to ensure neither corrupts the other's write
- **AND** the second writer's rename SHALL fail harmlessly; both workers then read the same final directory

### Requirement: Webhook fire

The `.webhook(triggerName, opts?)` method SHALL issue an HTTP request to `POST /webhooks/<owner>/<repo>/<workflow>/<triggerName>` against the spawned child and capture the response into `state.responses`.

#### Scenario: Webhook with body

- **WHEN** `.webhook("ping", {body: {x: 1}})` is called
- **THEN** the framework SHALL POST `{x: 1}` as JSON to the webhook endpoint
- **AND** the response (status, headers, body) SHALL be appended to `state.responses`

#### Scenario: Webhook with headers and query

- **WHEN** `.webhook("ping", {body: {}, headers: {"x-test": "abc"}, query: {flag: "on"}})` is called
- **THEN** the request SHALL include the headers and the URL SHALL include the query string

#### Scenario: Webhook owner/repo override

- **WHEN** `.webhook("ping", {owner: "acme", repo: "lib"})` is called
- **THEN** the request SHALL go to `/webhooks/acme/lib/<workflow>/ping`

#### Scenario: Webhook does not block

- **WHEN** `.webhook(...)` is called
- **THEN** the chain SHALL proceed to the next step without awaiting completion of the runtime invocation
- **AND** the in-flight request promise SHALL be tracked; awaited at end-of-chain or at the next `.expect`

### Requirement: Manual fire

The `.manual(triggerName, input?, opts?)` method SHALL issue an HTTP POST to `/api/triggers/<owner>/<repo>/<workflow>/<triggerName>` with authenticated headers and capture the response into `state.responses`.

#### Scenario: Manual fire with input

- **WHEN** `.manual("greet", {name: "world"})` is called
- **THEN** the framework SHALL POST `{name: "world"}` as JSON to the manual trigger endpoint
- **AND** the request SHALL include `Authorization: User <user>` and `X-Auth-Provider: local` (default user `"dev"`)

#### Scenario: Manual fire is fire-and-forget

- **WHEN** `.manual(...)` is called
- **THEN** the chain SHALL proceed without awaiting completion
- **AND** the in-flight promise SHALL be tracked

### Requirement: Fetch step

The `.fetch(path, opts?)` method SHALL issue an HTTP request to the spawned child for paths that are not workflow triggers (e.g. `/health`, `/api/workflows/<owner>`, `/dashboard/<owner>`) and capture the response into `state.fetches`.

#### Scenario: Plain fetch

- **WHEN** `.fetch("/health")` is called
- **THEN** the framework SHALL GET `/health` against the spawned child
- **AND** the response (status, headers, body) SHALL be appended to `state.fetches`

#### Scenario: Fetch with auth via cookie

- **WHEN** `.fetch("/dashboard/dev", {auth: {user: "dev", via: "cookie"}})` is called
- **THEN** the framework SHALL POST `name=dev` to `/auth/local/signin` (cached per child+user+via), capture the sealed `session` cookie, and attach it to the fetch
- **AND** subsequent fetches with the same `(user, via)` SHALL reuse the cached cookie

#### Scenario: Fetch with auth via api-header

- **WHEN** `.fetch("/api/workflows/acme", {auth: {user: "alice", via: "api-header"}})` is called
- **THEN** the framework SHALL include `Authorization: User alice` and `X-Auth-Provider: local` headers

### Requirement: WaitForEvent synchronization

The `.waitForEvent(filter, opts?)` method SHALL block the chain until an invocation event matching the filter is observable in the spawned child's persistence directory.

#### Scenario: Wait for in-flight invocation

- **WHEN** `.waitForEvent({label: "fire1", archived: false})` is called after a labeled fire step
- **THEN** the framework SHALL poll `<persistencePath>/pending/*.json` at ~25 ms cadence
- **AND** SHALL resolve when a file with matching invocation metadata appears
- **AND** SHALL fail with a diagnostic listing observed events if no match within `hardCap` (default 5000 ms)

#### Scenario: Wait for archived invocation

- **WHEN** `.waitForEvent({label: "fire1", archived: true, kind: "trigger.error"})` is called
- **THEN** the framework SHALL poll `<persistencePath>/archive/*.json`
- **AND** SHALL match files containing the labeled invocation and the specified `kind`

#### Scenario: Filter by trigger name and owner/repo

- **WHEN** `.waitForEvent({trigger: "tick", owner: "dev", repo: "e2e"})` is called
- **THEN** the framework SHALL match events from the cron trigger `tick` under owner `dev`, repo `e2e`

### Requirement: Expect with vitest matchers

The `.expect(callback)` method SHALL accept a callback receiving `ScenarioState` and using `expect` from vitest. The framework SHALL re-run the callback on every state change until it passes or hits `hardCap` (default 5000 ms).

#### Scenario: Expect passes immediately

- **WHEN** the callback's matchers all pass on first invocation
- **THEN** the chain SHALL proceed to the next step without delay

#### Scenario: Expect retries on state change

- **WHEN** the callback throws a vitest matcher error on first invocation
- **THEN** the framework SHALL re-run the callback whenever new state arrives (new event, new log line, new mock capture, new HTTP response settling)
- **AND** SHALL stop retrying when the callback passes or `hardCap` is exceeded

#### Scenario: Expect failure surfaces last matcher error

- **WHEN** the callback never passes within `hardCap`
- **THEN** the chain step SHALL fail with the LAST thrown matcher error from vitest
- **AND** the failure message SHALL include a one-line prefix listing observable state at failure (e.g. "Scenario state at failure: 4 events, 12 logs, 0 mock captures")

#### Scenario: Async callback supported

- **WHEN** the callback returns a Promise (e.g. awaits `mocks.smtp.captures(...)`)
- **THEN** the framework SHALL await the Promise as part of each retry attempt

### Requirement: SIGKILL chain step

The `.sigkill(opts?)` method SHALL send SIGKILL to the spawned child. When `opts.restart` is true, the framework SHALL respawn against the same persistence directory after the kill.

#### Scenario: Plain sigkill

- **WHEN** `.sigkill()` is called
- **THEN** the framework SHALL send SIGKILL to the child process
- **AND** SHALL await the child's `exit` event before proceeding

#### Scenario: Sigkill with restart

- **WHEN** `.sigkill({restart: true})` is called
- **THEN** after the child exits, the framework SHALL spawn a new child against the SAME `PERSISTENCE_PATH`, `SECRETS_PRIVATE_KEYS`, and other env from the original spawn
- **AND** SHALL wait for the new child to log `http.listening` before the chain proceeds

### Requirement: SIGTERM chain step

The `.sigterm(opts?)` method SHALL send SIGTERM to the spawned child and wait for the `shutdown.complete` log line.

#### Scenario: Sigterm waits for graceful shutdown

- **WHEN** `.sigterm()` is called
- **THEN** the framework SHALL send SIGTERM to the child
- **AND** SHALL await a stdout log line `{msg: "shutdown.complete", code, durationMs}` before the child exits
- **AND** SHALL fail with a diagnostic if the line does not appear before the child exits or before a hard cap

#### Scenario: Sigterm with restart

- **WHEN** `.sigterm({restart: true})` is called
- **THEN** after graceful shutdown completes, the framework SHALL spawn a new child against the same persistence dir and wait for `http.listening`

### Requirement: Browser chain step

The `.browser(callback)` method SHALL invoke the callback with a configured Playwright `page`, the live `ScenarioState`, and a `login(user)` helper.

#### Scenario: Browser context configured with baseURL

- **WHEN** `.browser(async ({page}) => page.goto("/login"))` is called
- **THEN** the page's `BrowserContext` SHALL be configured with `baseURL: <child.baseUrl>`
- **AND** `page.goto("/login")` SHALL resolve against the spawned child's URL

#### Scenario: Fresh context per browser step

- **WHEN** two `.browser()` callbacks run within the same suite
- **THEN** each SHALL receive a fresh `BrowserContext` with no shared cookies or storage

#### Scenario: Login helper

- **WHEN** the callback calls `login("dev")`
- **THEN** the framework SHALL drive the login form (`/login` → select `name=dev` → submit) and return when the page reaches `/dashboard`

### Requirement: ScenarioState shape

The `ScenarioState` interface SHALL expose all of the following fields, even when empty: `workflows`, `uploads`, `responses`, `fetches`, `events`, `archives`, `logs`, `http`, `smtp`, `sql`. Repeatable-step collections (`workflows`, `uploads`, `responses`, `fetches`, `archives`) SHALL be of type `CapturedSeq<T>`.

#### Scenario: All fields present from PR 1

- **WHEN** any test inspects `state` in an `.expect` callback
- **THEN** every field SHALL be defined (empty arrays / placeholder mock clients if the test hasn't populated them)

#### Scenario: CapturedSeq array interface

- **WHEN** a test accesses `state.responses[0]`
- **THEN** the access SHALL return the first captured response, equivalent to a readonly array

#### Scenario: CapturedSeq byLabel lookup

- **WHEN** a test accesses `state.fetches.byLabel("bobApi")` and a prior `.fetch(...)` was called with `{label: "bobApi"}`
- **THEN** the lookup SHALL return that fetch's result

#### Scenario: CapturedSeq byLabel throws on missing label

- **WHEN** `state.fetches.byLabel("missing")` is called and no fetch carried that label
- **THEN** the lookup SHALL throw an error naming the missing label

### Requirement: Event source via filesystem polling

`state.events` and `.waitForEvent` SHALL source invocation events from the spawned child's persistence directory (`pending/*.json` for in-flight, `archive/*.json` for terminal). The framework SHALL NOT subscribe to runtime log lines for invocation events.

#### Scenario: Events read from persistence dir

- **WHEN** an `.expect` callback reads `state.events`
- **THEN** the framework SHALL read all files under `<persistencePath>/pending/` and `<persistencePath>/archive/` and parse each as JSON
- **AND** SHALL return the parsed events

#### Scenario: No log-line subscription for events

- **WHEN** the runtime emits an `invocation.completed` log line
- **THEN** the framework SHALL NOT use that line as a sync point for `.waitForEvent`
- **AND** the test's view of events SHALL come exclusively from filesystem reads

### Requirement: Log observation with auto-scoping

`state.logs` SHALL be a snapshot of structured pino log lines from the spawned child's stdout, scoped to lines emitted since the test's `mark()`. The framework SHALL auto-mark at each test's `beforeEach`.

#### Scenario: Logs visible since test start

- **WHEN** an `.expect` callback reads `state.logs`
- **THEN** only log lines emitted between the test's start and the moment of access SHALL be visible
- **AND** lines from prior tests in the same describe SHALL NOT be visible

#### Scenario: assertNotPresent on logs

- **WHEN** a test asserts `expect(state.logs.every(l => !JSON.stringify(l).includes(secret))).toBe(true)` (or equivalent helper)
- **THEN** the assertion SHALL pass only if `secret` does not appear in any log line emitted during the test

### Requirement: Mock services via createMockServer factory

The framework SHALL provide a `createMockServer(mock: Mock<TCapture, TConn>)` factory that wires a uniform admin HTTP server around any mock implementation. The factory SHALL be the only path used by the three mocks shipped with the framework.

#### Scenario: Mock interface

- **WHEN** a mock is implemented
- **THEN** it SHALL conform to `interface Mock<TCapture, TConn> { name: string; start(record): Promise<TConn>; stop(): Promise<void>; }`
- **AND** SHALL push captures via the `record` callback

#### Scenario: Admin server protocol

- **WHEN** a `createMockServer` instance is started
- **THEN** it SHALL bind a random free port on 127.0.0.1
- **AND** SHALL expose `GET /captures?slug=<slug>&since=<ts>`, `GET /stream?slug=<slug>`, `POST /reset?slug=<slug>` endpoints
- **AND** the `/stream` endpoint SHALL replay matching backlog captures, then keep the connection open and push new captures via SSE

#### Scenario: Three mocks ship with framework

- **WHEN** the framework is fully implemented
- **THEN** three concrete mocks SHALL exist: an embedded-postgres mock (with optional TLS), an HTTP echo mock, an SMTP catcher mock
- **AND** all three SHALL be wired via `createMockServer`

### Requirement: Cross-worker mock sharing via vitest provide/inject

The framework's `globalSetup` SHALL boot the three mocks once per suite run and expose their connection info to all workers via vitest's `provide`/`inject` mechanism. No tmp-file manifest SHALL be used.

#### Scenario: Mocks provided once

- **WHEN** the suite starts
- **THEN** `globalSetup` SHALL call `provide("mocks", {pg: {adminUrl, connection}, echo: {adminUrl, connection}, smtp: {adminUrl, connection}})`
- **AND** `globalTeardown` SHALL stop all three mocks

#### Scenario: Workers inject

- **WHEN** any worker starts
- **THEN** it SHALL `inject("mocks")` to obtain the connection info
- **AND** SHALL connect to the suite-shared mock instances

### Requirement: Per-test correlation via slug

Every test SHALL have a unique slug derived from `<file-basename>-<describe-name>-<test-name>`, slugified to fit the owner regex (`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`), with hash-suffix overflow handling.

#### Scenario: Slug shape

- **WHEN** a test runs
- **THEN** its slug SHALL match the owner regex
- **AND** SHALL be deterministic given the file name + describe name + test name

#### Scenario: Slug used for workflow names

- **WHEN** a test calls `.workflow("foo", source)` without explicit owner/repo
- **THEN** the workflow name visible to the runtime SHALL incorporate the slug to prevent cross-test collisions

#### Scenario: Slug used for mock filtering

- **WHEN** an HTTP echo capture or SMTP capture or pg query carries the slug (via URL path, recipient plus-address, or DB name)
- **THEN** the mock SHALL attribute the capture to that slug
- **AND** test-side queries `.captures({slug})` and `.waitFor(pred, {slug})` SHALL filter accordingly

### Requirement: Mock client uniform surface

A single `MockClient<TCapture>` class SHALL consume all three mocks via the admin protocol, exposing exactly three methods: `captures`, `waitFor`, `reset`.

#### Scenario: Captures snapshot

- **WHEN** `client.captures({slug})` is called
- **THEN** it SHALL return a Promise resolving to all currently-buffered captures matching the slug

#### Scenario: WaitFor matches backlog or live

- **WHEN** `client.waitFor(predicate, {slug})` is called
- **THEN** the client SHALL open `/stream?slug=<slug>` and resolve on the first capture matching the predicate (whether from the backlog replay or the live stream)
- **AND** SHALL close the SSE connection upon resolving

#### Scenario: Reset clears slug-scoped captures

- **WHEN** `client.reset(slug)` is called
- **THEN** the mock server SHALL drop all captures matching the slug

### Requirement: Mock crash detection

The `MockClient` SHALL detect mock unreachability (connection refused or stream error) and fail the test fast with a clear diagnostic.

#### Scenario: Mock unreachable

- **WHEN** any mock's admin server is unreachable during a `MockClient` call
- **THEN** the call SHALL throw an error of the form `mock <name> at <adminUrl> unreachable — likely crashed; check globalSetup logs`

### Requirement: Parallelism layout

The framework SHALL run vitest workers in parallel (default = one per CPU). Within a worker, files SHALL execute in vitest's default order; within a non-destructive describe, tests SHALL run via `test.concurrent`. Destructive tests (those that signal the child or require custom child env) SHALL run in their own describes with sequential execution.

#### Scenario: Workers run files in parallel

- **WHEN** the suite has multiple test files and the machine has multiple CPUs
- **THEN** files SHALL run in parallel up to the worker pool limit

#### Scenario: Non-destructive concurrency

- **WHEN** a describe contains tests that do not signal the child or require unique env
- **THEN** those tests SHALL be wrapped in `test.concurrent` and run in parallel against one shared spawned child

#### Scenario: Destructive isolation

- **WHEN** a test signals the spawned child (`.sigterm`, `.sigkill`) or requires unique describe env (e.g. `SANDBOX_MAX_COUNT=2`)
- **THEN** the test SHALL be in its own describe with its own spawned child

### Requirement: 19 end-to-end tests

The framework SHALL ship the following end-to-end tests, each testing one invariant that cannot be covered by in-process or unit tests:

1. Sealed secret round-trip + log redaction
2. Cold start from DuckLake catalog (committed invocations remain queryable across graceful restart)
3. Graceful SIGTERM drain (in-flight invocation surfaces as a `trigger.error{kind:"shutdown"}` synthetic terminal in the archive after respawn)
4. Health endpoint shape
5. Workflow re-upload + sandbox eviction log line
6. Multi-backend reconfigure (one workflow registers http + cron)
7. Sandbox LRU eviction under count pressure (`SANDBOX_MAX_COUNT=2`)
8. Cross-owner 404 isolation (API + dashboard)
9. Local login + signout (Playwright)
10. Dashboard renders invocation row (Playwright)
11. Trigger UI manual-fire (Playwright)
12. SQL TLS handshake against embedded-postgres
13. SQL `statement_timeout` cancellation
14. Plain env literal round-trip
15. httpTrigger protocol adapter (headers, query, body, response shape, 422)
16. cronTrigger fires (real wall-clock)
17. fetch SSRF guard rejects loopback
18. sendMail happy path + SMTP password log redaction
19. Owner/repo scoping (same workflow name under multiple `(owner, repo)` tuples)
20. wsTrigger protocol adapter
21. CHECKPOINT survives restart (multiple invocations across DuckLake checkpoint cycles remain queryable after respawn)

The previous "SIGKILL crash recovery (engine_crashed event after respawn)" test is removed. Under `event-store-ducklake`, the per-event WAL is gone and SIGKILL during an in-flight invocation deliberately loses it — there is no `engine_crashed` synthetic terminal to assert on. The graceful-shutdown contract is exercised by the rewritten test #3 (SIGTERM synthesises `trigger.error{kind:"shutdown"}`); the durable round-trip contract is exercised by the new test #2 (cold start from catalog).

#### Scenario: Each test exists

- **WHEN** the suite is fully implemented
- **THEN** every test in the list SHALL exist under `packages/tests/test/`
- **AND** each SHALL pass under `pnpm test:e2e`

#### Scenario: Each test is single-feature, E2E-only

- **WHEN** a test is added to the suite
- **THEN** the test SHALL exercise exactly one runtime invariant whose failure mode requires the spawn → upload → fire → archive lifecycle
- **AND** the assertion SHALL be on the resulting `state.events` (or `state.fetches` / `state.responses`) shape — not on an in-process detail that would be cheaper to unit-test

### Requirement: WS chain step

The chain DSL exported from `@workflow-engine/tests` SHALL include a `.ws(triggerName, opts?, callback)` method. Calling it queues a step that, at run time, opens a real WebSocket connection against the spawned runtime, runs the user-supplied async `callback`, then auto-closes the connection if the callback didn't already close it.

`opts` (optional) SHALL accept:
- `auth?: { user: string; via?: "api-header" }` — Bearer token derived from the user's `AUTH_ALLOW` entry (default `via: "api-header"`; no other modes supported in v1).
- `owner?: string` — defaults to `"dev"`.
- `repo?: string` — defaults to `"e2e"`.
- `workflow?: string` — defaults to the most recently uploaded workflow name in scope.
- `label?: string` — optional capture label (currently unused; reserved for future cross-step state).

`callback` SHALL receive a single argument `sock` whose surface is frozen for v1:
- `sock.send(data: unknown): Promise<unknown>` — JSON-serializes `data`, sends it as a single text frame, and resolves with the parsed JSON of the next inbound frame from this connection (FIFO-correlated). Rejects if the connection closes before a reply arrives.
- `sock.sendRaw(payload: string | Buffer): void` — fire-and-forget; sends the payload as-is. Used to test malformed-input close paths.
- `sock.closed: Promise<{ code: number; reason?: string }>` — resolves when the peer closes the connection. Used to assert close codes.
- `sock.close(code?: number): void` — client-initiated close (default `1000`).

The framework SHALL set `Authorization: Bearer <token>` on the upgrade request when `auth.user` is provided, using the same token-minting logic as the `.fetch` step.

The framework SHALL automatically `sock.close(1000)` any still-open connection at the end of the callback.

#### Scenario: Happy-path send/receive

- **GIVEN** a workflow uploaded with a `wsTrigger` named `echo`
- **WHEN** a test runs `.ws('echo', { auth: { user: 'alice' } }, async sock => { const r = await sock.send({greet:'hi'}); expect(r).toEqual({echo:'hi'}) })`
- **THEN** the framework SHALL open a WS connection to `/ws/dev/e2e/<workflow>/echo` with the correct Bearer token
- **AND** SHALL deliver the reply frame to `sock.send`'s resolved value
- **AND** SHALL close the connection with code `1000` after the callback returns

#### Scenario: sendRaw + closed for malformed-input test

- **GIVEN** a wsTrigger with a strict `request` schema
- **WHEN** a test runs `.ws('strict', { auth: { user: 'alice' } }, async sock => { sock.sendRaw('not json'); const c = await sock.closed; expect(c.code).toBe(1007) })`
- **THEN** `sock.sendRaw` SHALL deliver the literal text frame `not json`
- **AND** `sock.closed` SHALL resolve with `{code: 1007}`

### Requirement: Two e2e tests for wsTrigger protocol adapter

The e2e suite at `packages/tests/test/` SHALL include a numbered test file for the wsTrigger protocol adapter, following the test-author surface defined in this capability. The file SHALL contain at minimum two tests parallel in shape to test `15-http-trigger-protocol.test.ts`:

1. **Happy path**: open a WS connection to a wsTrigger whose handler echoes its input; assert the reply frame's content.
2. **Schema mismatch closes 1007**: send a JSON payload that violates the `request` schema; assert `sock.closed.code === 1007`.

Additional close-code paths (`1011` handler-throw, `1012` reconfigure, heartbeat, FIFO ordering across concurrent frames, cross-owner 404) SHALL NOT be covered by e2e tests; they live in the unit test suite at `packages/runtime/src/triggers/ws.test.ts`. This split mirrors the existing httpTrigger coverage shape (e2e covers protocol adapter happy + schema-422; unit covers the exhaustive logic matrix).

#### Scenario: Two e2e tests exist

- **WHEN** the e2e suite is collected
- **THEN** the new test file SHALL contain at least two `test(...)` calls
- **AND** one SHALL exercise the happy-path send/receive
- **AND** one SHALL exercise the 1007 close path via `sendRaw` + `closed`

