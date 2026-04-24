## ADDED Requirements

### Requirement: createSqlPlugin factory

The sandbox-stdlib package SHALL export a `createSqlPlugin(): Plugin` factory. The plugin SHALL declare `name: "sql"` and `dependsOn: ["web-platform"]`. The plugin SHALL register a private (`public` unset) guest function descriptor named `$sql/do` whose handler invokes the `postgres` (porsager/postgres) driver via `sql.unsafe(query, params)` to execute parameterized SQL against a Postgres server and returns `{rows, columns, rowCount}` on success, where every value in `rows` and every `ColumnMeta` in `columns` is JSON-safe. The descriptor SHALL declare `log: { request: "sql" }`, a `logName` producing `"sql to <host>/<database>"`, and a `logInput` returning `{engine: "postgres", host, database, query, paramCount}` (deliberately omitting `params`). The handler SHALL call the net-guard primitive `assertHostIsPublic(originalHost)` BEFORE constructing the `postgres()` handle, and SHALL override the driver options with `host: <validatedIp>` so the driver's own `socket.connect(port, host)` path connects to the pre-resolved IP rather than re-resolving DNS. The handler SHALL pin `ssl.servername` to `originalHost` whenever `ssl` is truthy so TLS SNI and certificate verification remain bound to the hostname the author specified; when the author's DSN includes `sslmode=require`/`verify-ca`/`verify-full`/`prefer`/`allow` but no `ssl` object was supplied, the handler SHALL synthesize `ssl: { servername: originalHost, rejectUnauthorized: false }` so the servername pin still applies after the host override. The handler SHALL configure the Postgres connection with `max: 1`, `prepare: false`, `connect_timeout: 10` (seconds), and `connection.statement_timeout` set to the effective `timeoutMs` (default 30_000 ms, clamped to a hard ceiling of 120_000 ms). The handler SHALL call `sql.end({timeout: 5})` in a `finally` block on both success and failure. The plugin SHALL define `onRunFinished` as a backstop that forces `sql.end({timeout: 0})` on any handle still open.

The plugin SHALL convert every value `postgres` returns to a JSON-safe form before replying to the guest, following this fixed mapping:

- `int2`, `int4`, `float4`, `float8`, and `numeric` values fitting an IEEE-754 f64 → `number`;
- `int8` and any `numeric` exceeding f64 → `string` (decimal representation);
- `bool` → `boolean`;
- `text`, `varchar`, `char`, `uuid`, `name` → `string`;
- `timestamp`, `timestamptz`, `date`, `time`, `timetz` → `string` (ISO-8601);
- `bytea` → `string` (base64);
- `json`, `jsonb` → parsed JSON value (object, array, or scalar);
- array types → JSON array with the same recursive mapping applied to each element;
- composite, range, and geometric types → `string` in the Postgres text form returned by the driver;
- `NULL` → `null`.

`ColumnMeta` SHALL carry `{name: string, dataTypeID: number}` for each returned column, preserving the Postgres OID so guest code can disambiguate values that share a JSON representation (e.g. `timestamptz` vs. `text`).

For a multi-statement query (invoked with an empty `params` array, which routes through Postgres's simple-query protocol) the handler SHALL return the result set of the **last** statement only. Queries invoked with a non-empty `params` array use Postgres's extended protocol, which supports parameter binding but requires a single statement; in that case the handler SHALL return that single statement's result set.

#### Scenario: SQL query emits sql.request/sql.response triad

- **GIVEN** guest code awaits `executeSql(conn, "SELECT $1::text AS greeting", ["hi"])` and the driver returns one row
- **WHEN** the handler completes successfully
- **THEN** a `sql.request` event SHALL be emitted with `createsFrame: true` carrying `input = {engine: "postgres", host, database, query: "SELECT $1::text AS greeting", paramCount: 1}`
- **AND** a `sql.response` event SHALL be emitted with `closesFrame: true` carrying `output = {rowCount: 1, durationMs}`
- **AND** neither event SHALL contain the string `"hi"`

#### Scenario: SQL query to RFC-1918 host is refused before socket

- **GIVEN** guest code awaits `executeSql("postgres://db.internal/app", "SELECT 1")` and DNS resolves `db.internal` to `10.0.0.5`
- **WHEN** `assertHostIsPublic("db.internal")` rejects with `HostBlockedError`
- **THEN** `postgres()` SHALL NOT be called and no TCP socket SHALL be opened
- **AND** a `sql.error` event SHALL be emitted with `output = {message: <HostBlockedError message>}` and no `code` field

#### Scenario: options.host is overridden with the validated IP

- **GIVEN** `assertHostIsPublic("db.example.com")` resolves to `203.0.113.42`
- **WHEN** the plugin calls `postgres(url, options)`
- **THEN** `options.host` SHALL equal `"203.0.113.42"`
- **AND** `options.host` SHALL NOT equal `"db.example.com"`

#### Scenario: DSN sslmode=require auto-synthesizes ssl.servername

- **GIVEN** the author passes a string connection `"postgres://db.example.com/app?sslmode=require"` with no explicit `ssl` field
- **WHEN** the plugin constructs the `postgres()` options
- **THEN** `options.ssl` SHALL be `{servername: "db.example.com", rejectUnauthorized: false}`
- **AND** TLS SNI SHALL therefore bind to the original hostname rather than the validated IP that replaced `options.host`

#### Scenario: TLS servername is pinned to the original hostname

- **GIVEN** the author supplies `ssl: true` with `connectionString: "postgres://db.example.com/app"`
- **WHEN** the plugin constructs the `postgres()` options
- **THEN** the merged `ssl` object SHALL contain `servername: "db.example.com"`
- **AND** every other `ssl.*` field the author supplied SHALL pass through unchanged

#### Scenario: Author TLS PEMs pass through

- **GIVEN** the author supplies `ssl: {ca: "-----BEGIN CERTIFICATE-----...", rejectUnauthorized: true}`
- **WHEN** the plugin constructs the `postgres()` options
- **THEN** `ssl.ca`, `ssl.cert` (if set), `ssl.key` (if set), and `ssl.rejectUnauthorized` SHALL equal the author-supplied values

#### Scenario: statement_timeout default and ceiling

- **WHEN** the author does not pass `options.timeoutMs`
- **THEN** the plugin SHALL call `postgres()` with `connection.statement_timeout === "30000"`
- **WHEN** the author passes `options.timeoutMs = 5000`
- **THEN** the plugin SHALL call `postgres()` with `connection.statement_timeout === "5000"`
- **WHEN** the author passes `options.timeoutMs = 999999`
- **THEN** the plugin SHALL clamp the value and call `postgres()` with `connection.statement_timeout === "120000"`

#### Scenario: Structured error for statement_timeout

- **GIVEN** a query exceeds `statement_timeout` and the Postgres server cancels it
- **WHEN** the driver rejects with SQLSTATE `57014`
- **THEN** a `sql.error` event SHALL be emitted with `output = {message, code: "57014"}`

#### Scenario: Structured error for auth failure

- **GIVEN** the Postgres server rejects the plugin's credentials
- **WHEN** the driver rejects with SQLSTATE `28P01`
- **THEN** a `sql.error` event SHALL be emitted with `output = {message, code: "28P01"}`

#### Scenario: Structured error for syntax error

- **GIVEN** the author passes `query: "SELCT 1"`
- **WHEN** the driver rejects with SQLSTATE `42601`
- **THEN** a `sql.error` event SHALL be emitted with `output = {message, code: "42601"}`

#### Scenario: Structured error for connection failure

- **GIVEN** the hardened socket cannot complete TCP or TLS within `connect_timeout`
- **WHEN** the driver rejects before the Postgres startup handshake completes
- **THEN** a `sql.error` event SHALL be emitted with `output = {message}` and no `code` field

#### Scenario: Row coercion maps timestamptz to ISO string

- **GIVEN** the driver returns a row value that is a `Date` instance for a `timestamptz` column
- **WHEN** the handler serializes the row for the guest
- **THEN** the guest SHALL receive `typeof value === "string"` with the value equal to `date.toISOString()`

#### Scenario: Row coercion maps bytea to base64 string

- **GIVEN** the driver returns a row value that is a `Buffer` or `Uint8Array` for a `bytea` column
- **WHEN** the handler serializes the row for the guest
- **THEN** the guest SHALL receive `typeof value === "string"` with the value equal to the base64 encoding of the bytes

#### Scenario: Row coercion maps bigint to decimal string

- **GIVEN** the driver returns a row value for an `int8` column that does not fit an IEEE-754 safe integer
- **WHEN** the handler serializes the row for the guest
- **THEN** the guest SHALL receive `typeof value === "string"` with the value equal to the decimal representation of the integer

#### Scenario: Row coercion passes jsonb objects through

- **GIVEN** the driver returns a row value that is a plain object for a `jsonb` column
- **WHEN** the handler serializes the row for the guest
- **THEN** the guest SHALL receive an equivalent plain object whose nested values follow the same JSON-safe mapping

#### Scenario: Multi-statement query (no params) returns last result set

- **GIVEN** the author passes `query: "SELECT 1 AS a; SELECT 2 AS b"` with no `params`
- **WHEN** the handler completes
- **THEN** the simple-query protocol SHALL be used
- **AND** the guest SHALL receive `rows = [{b: 2}]` (or the coerced equivalent)
- **AND** the guest SHALL NOT receive `rows` for the first statement

#### Scenario: Params are bound via $N placeholders

- **GIVEN** the author passes `query: "SELECT * FROM t WHERE id = $1"` and `params: [42]`
- **WHEN** the handler invokes the driver
- **THEN** the driver SHALL be called via `sql.unsafe("SELECT * FROM t WHERE id = $1", [42])` using Postgres's extended protocol
- **AND** the value `42` SHALL NOT appear in the `sql.request.input.query` string

#### Scenario: Per-call connection is closed in finally on success

- **GIVEN** a successful `executeSql` call
- **WHEN** the handler returns
- **THEN** `sql.end({timeout: 5})` SHALL have been awaited before the handler resolves

#### Scenario: Per-call connection is closed in finally on error

- **GIVEN** any failure path (host blocked, connect failure, query failure, timeout)
- **WHEN** the handler rejects
- **THEN** `sql.end({timeout: 5})` SHALL have been awaited before the rejection surfaces

#### Scenario: onRunFinished forces close of leaked handles

- **GIVEN** a malformed handler path that leaks an open `sql` handle past its `finally`
- **WHEN** `sb.run()` completes and `onRunFinished` fires
- **THEN** `sql.end({timeout: 0})` SHALL be called on every handle the plugin created during that run

### Requirement: Hardened-egress coverage extension

The `assertHostIsPublic` primitive SHALL be called before socket creation by every outbound-TCP plugin exported from sandbox-stdlib: `createFetchPlugin`, `createMailPlugin`, and `createSqlPlugin`. Each plugin SHALL pass the validated IP to the underlying transport (either via direct `net.connect({host: ip, port})` for fetch, via `nodemailer`'s `host: validatedIp` + `tls.servername: hostname` for mail, or via `postgres()`'s `host: validatedIp` + synthesized `ssl.servername: hostname` for sql) and SHALL NOT allow the driver to perform its own DNS resolution on the hostname after validation.

#### Scenario: Every outbound plugin routes through net-guard

- **GIVEN** any sandbox-stdlib plugin that opens an outbound TCP socket
- **WHEN** the plugin receives a host from guest-supplied configuration
- **THEN** the plugin SHALL await `assertHostIsPublic(host)` before creating any `net.Socket`
- **AND** the plugin SHALL connect using the validated IP rather than the hostname

### Requirement: SQL event param-value redaction

The `sql.request` event SHALL carry `input.query` as the full SQL text the author supplied and SHALL NOT carry any param values. The descriptor's `logInput` SHALL emit `{engine, host, database, query, paramCount}` with `paramCount` being `params.length` (or `0` when `params` is omitted). No event emitted by `createSqlPlugin` — `sql.request`, `sql.response`, or `sql.error` — SHALL contain an element of `params`.

#### Scenario: Param values never appear in sql.request

- **GIVEN** the author passes `params: ["secret-token", 42, true]`
- **WHEN** the plugin emits `sql.request`
- **THEN** the event's `input` SHALL have `paramCount: 3`
- **AND** the event payload (including `input` and `meta`) SHALL NOT contain the string `"secret-token"`, the number `42`, or the boolean `true` in a position attributable to a param

#### Scenario: Param values never appear in sql.response

- **GIVEN** a successful query with `params: ["secret-token"]`
- **WHEN** the plugin emits `sql.response`
- **THEN** the event's `output` SHALL be `{rowCount, durationMs}` only
- **AND** the event payload SHALL NOT contain the string `"secret-token"`

#### Scenario: Param values never appear in sql.error

- **GIVEN** a query that fails while referencing `params: ["secret-token"]`
- **WHEN** the plugin emits `sql.error`
- **THEN** the event's `output` SHALL be `{message, code?}` only
- **AND** the event payload SHALL NOT contain the string `"secret-token"`
