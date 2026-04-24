## ADDED Requirements

### Requirement: executeSql export

The SDK SHALL export a named function `executeSql` from `@workflow-engine/sdk` with the signature:

```
executeSql(
  connection: Connection,
  query: string,
  params?: Param[],
  options?: { timeoutMs?: number },
): Promise<SqlResult>
```

`Connection` SHALL be the union `string | ConnectionObject`. When `connection` is a string, the SDK SHALL pass it through to the bridge as-is, treating it as a Postgres connection URI (e.g. `postgres://user:pass@host:port/db?sslmode=require`). `ConnectionObject` SHALL carry all of the optional fields `connectionString`, `host`, `port`, `user`, `password`, `database`, and `ssl`, mirroring the porsager/postgres `Options` shape. `ssl` SHALL be either `boolean` or an object accepting `ca`, `cert`, `key` (each a PEM `string`) and `rejectUnauthorized` (`boolean`). The SDK SHALL NOT merge, re-order, or precedence-override any of these fields — merging semantics are delegated to the underlying driver.

`Param` SHALL be the JSON-scalar union `string | number | boolean | null`. The SDK SHALL reject any other value type (`Date`, `Uint8Array`, `BigInt`, `Object`) at the call boundary before bridging. Authors requiring non-JSON types SHALL encode them at the call site (e.g. `Date.toISOString()`, base64 string, decimal string).

`SqlResult` SHALL have the shape `{rows: Row[], columns: ColumnMeta[], rowCount: number}`, where `Row` is `Record<string, SqlValue>`, `ColumnMeta` is `{name: string, dataTypeID: number}`, and `SqlValue` is the recursive JSON-safe union (`string | number | boolean | null | SqlValue[] | { [k: string]: SqlValue }`). The SDK SHALL NOT receive or construct `Date`, `Uint8Array`, `BigInt`, or any non-JSON value instance from the bridge.

`options.timeoutMs` SHALL be a positive integer number of milliseconds when provided. The SDK SHALL forward it to the bridge; the sandbox-stdlib SQL plugin is responsible for clamping and defaulting per the `createSqlPlugin` spec.

The function SHALL invoke the private `$sql/do` host-callable descriptor with the payload `{connection, query, params, options}` and SHALL resolve with the driver's JSON-safe result unchanged, or reject with the structured error envelope propagated from the bridge (`{message: string, code?: string}`).

#### Scenario: Author imports and calls executeSql

- **GIVEN** an action handler that does `import { executeSql } from "@workflow-engine/sdk"`
- **WHEN** the action awaits `executeSql("postgres://reader:pw@db.example.com/app?sslmode=require", "SELECT 1 AS x")` and the call succeeds
- **THEN** the call SHALL resolve to an object with `rowCount: 1`, `columns: [{name: "x", dataTypeID: <int4-oid>}]`, and `rows: [{x: 1}]`

#### Scenario: Parameterized query passes $N params through

- **GIVEN** the action calls `executeSql(conn, "SELECT $1::int AS n", [42])`
- **WHEN** the SDK invokes `$sql/do`
- **THEN** the bridged payload SHALL have `params: [42]`
- **AND** the bridged payload SHALL have `query: "SELECT $1::int AS n"` unchanged

#### Scenario: Connection-object form passes fields through

- **GIVEN** the action calls `executeSql({host: "db.example.com", port: 5432, user: "u", password: "p", database: "d", ssl: {ca: "-----BEGIN CERTIFICATE-----..."}}, "SELECT 1")`
- **WHEN** the SDK invokes `$sql/do`
- **THEN** the bridged `connection` object SHALL preserve every supplied field unchanged
- **AND** the SDK SHALL NOT merge, drop, or rewrite any connection field

#### Scenario: Unsupported param type is rejected

- **GIVEN** the action calls `executeSql(conn, "INSERT INTO t(at) VALUES ($1)", [new Date()])`
- **WHEN** the SDK validates params before bridging
- **THEN** the SDK SHALL throw a `TypeError` naming the offending type
- **AND** the SDK SHALL NOT invoke `$sql/do`

#### Scenario: Default options when timeoutMs omitted

- **GIVEN** the action calls `executeSql(conn, "SELECT 1")` with no `options` and no `params`
- **WHEN** the SDK invokes `$sql/do`
- **THEN** the bridged payload SHALL have `params: []` (or equivalent empty array)
- **AND** the bridged payload SHALL either omit `options` or pass `options: {}` — the plugin is responsible for defaults

#### Scenario: Rows returned are JSON-safe

- **GIVEN** a query whose result columns cover `int4`, `text`, `timestamptz`, `bytea`, `jsonb`
- **WHEN** the SDK returns the `SqlResult` to the author
- **THEN** every value in every row SHALL be one of `string`, `number`, `boolean`, `null`, `Array`, or plain `Object`
- **AND** no value SHALL be a `Date`, `Uint8Array`, `Buffer`, or `BigInt` instance

#### Scenario: Structured error propagates unchanged

- **GIVEN** the host-side handler throws `{message: "canceling statement due to statement timeout", code: "57014"}`
- **WHEN** the SDK caller awaits `executeSql(...)`
- **THEN** the awaited promise SHALL reject with an error preserving `message` and `code`

#### Scenario: SDK surface identity list

- **GIVEN** `workflows/src/demo.ts` statically references SDK identity symbols in its `_sdkSurface` block
- **WHEN** any future rename or removal of `executeSql` at the SDK boundary occurs
- **THEN** `pnpm build` on `demo.ts` SHALL fail with a type or reference error, preventing silent SDK drift
