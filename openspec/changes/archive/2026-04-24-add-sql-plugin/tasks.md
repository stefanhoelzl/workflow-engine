## 1. Dependencies and scaffolding

- [x] 1.1 Add `postgres` (porsager/postgres) to `packages/sandbox-stdlib/package.json` dependencies; run `pnpm install`
- [x] 1.2 Create `packages/sandbox-stdlib/src/sql/` with empty `index.ts`, `worker.ts`, `types.ts`, `descriptor-name.ts`, and `sql.test.ts`
- [x] 1.3 Register the new event kinds `sql.request`, `sql.response`, `sql.error` in `packages/core/src/index.ts`

## 2. Worker (host-side) implementation

- [x] 2.1 Define Zod schemas in `types.ts`: `ConnectionSchema` (string union with object form), `ParamSchema` (JSON scalars only), `OptionsSchema` (`timeoutMs` positive integer), and the composite `InputSchema`
- [x] 2.2 Implement the hostname extraction helper: string connection → `new URL(s).hostname`; object connection → `config.host ?? new URL(config.connectionString).hostname`; reject if neither resolves to a hostname
- [x] 2.3 Implement the async `socket` factory: `assertHostIsPublic(originalHost)` → `net.connect({host: validatedIp, port})`; propagate errors through socket destroy
- [x] 2.4 Implement the `ssl` merge: when truthy, pin `servername: originalHost`; pass through author-supplied `ca`, `cert`, `key`, `rejectUnauthorized` verbatim
- [x] 2.5 Implement `clampTimeout`: default 30_000 ms, ceiling 120_000 ms
- [x] 2.6 Implement the row coercion function covering every mapping from the `createSqlPlugin` spec (int2/int4/float → number; int8/numeric-large → string; timestamptz → ISO string; bytea → base64; jsonb → passthrough; arrays recursive; composite → pg text form; NULL → null)
- [x] 2.7 Implement `handleSqlRequest` in `worker.ts`: construct `postgres()` with `max:1, prepare:false, connect_timeout:10, connection.statement_timeout: String(clampedMs)`, socket hook, merged ssl; `sql.unsafe(query, params)` (driver's default selects simple vs extended protocol based on params length); coerce rows; `sql.end({timeout:5})` in `finally`
- [x] 2.8 Implement `mapDriverError` → `{message, code?}` flat envelope, preserving Postgres SQLSTATE when present
- [x] 2.9 Implement the plugin factory `createSqlPlugin()` in `index.ts`: `name: "sql"`, `dependsOn: ["web-platform"]`, registers `$sql/do` with `log: {request: "sql"}`, `logName: "sql to <host>/<database>"`, `logInput: {engine, host, database, query, paramCount}`
- [x] 2.10 Implement `onRunFinished` backstop that iterates any tracked handles and forces `sql.end({timeout:0})`
- [x] 2.11 Export `createSqlPlugin` from `packages/sandbox-stdlib/src/index.ts`
- [x] 2.12 Register the new plugin in the runtime's sandbox-plugin composition site (same file/location where `createMailPlugin` is composed)

## 3. SDK wrapper (guest-side) implementation

- [x] 3.1 Create `packages/sdk/src/sql.ts` exporting `executeSql(connection, query, params?, options?)`, plus types `Connection`, `ConnectionObject`, `Param`, `SqlResult`, `Row`, `ColumnMeta`, `SqlValue`
- [x] 3.2 Implement param-type validation: throw `TypeError` for `Date`, `Uint8Array`, `BigInt`, objects, undefined; accept only `string | number | boolean | null`
- [x] 3.3 Call the `$sql/do` private descriptor with `{connection, query, params: params ?? [], options}`; resolve with the plugin's JSON-safe result; reject with the propagated error envelope unchanged
- [x] 3.4 Re-export `executeSql` and its types from `packages/sdk/src/index.ts`
- [x] 3.5 Author `/** … */` JSDoc on `executeSql` explaining: `$N` placeholders, JSON-only params, author-owned LIMIT discipline, and the underlying `sql.unsafe` call being parameterized+safe despite its name

## 4. Unit tests (following `mail.test.ts` pattern)

- [x] 4.1 Mock `node:dns/promises` and `postgres` with `vi.mock`; build test utilities to capture the `postgres()` options the worker passes
- [x] 4.2 Security test: DNS returns RFC-1918 → handler rejects before `postgres()` is called; `sql.error` emitted with HostBlockedError-shaped message and no `code`
- [x] 4.3 Security test: DNS returns IANA-reserved → same assertion as 4.2
- [x] 4.4 Security test: Socket factory calls `net.connect` with the validated IP (mocked `dns.resolve4` returns a public IP; assert `net.connect` args)
- [x] 4.5 Security test: When `ssl: true` and connection uses a hostname, the merged `ssl.servername` equals the original hostname
- [x] 4.6 Security test: Author `ssl.ca`, `ssl.cert`, `ssl.key`, `ssl.rejectUnauthorized` pass through unchanged
- [x] 4.7 Driver-call shape: `max: 1`, `prepare: false`, `connect_timeout: 10`, `connection.statement_timeout` equals effective clamped value for default / low / over-ceiling inputs
- [x] 4.8 Driver-call shape: `sql.unsafe` invoked with `(query, params)`; with non-empty params the driver's extended protocol is used (confirm via `.simple()` NOT being called)
- [x] 4.9 Event shape: `sql.request.input` has `{engine, host, database, query, paramCount}` and does NOT contain param values
- [x] 4.10 Event shape: `sql.response.output = {rowCount, durationMs}`; rows absent
- [x] 4.11 Event shape: `sql.error.output = {message, code?}` flat; code `"57014"` on statement_timeout simulation; code `"28P01"` on auth failure simulation; no code on connection failure simulation
- [x] 4.12 Row coercion: fake driver output for each mapping row (int2/4, int8, numeric, bool, text, timestamptz, bytea, jsonb, array of jsonb, NULL) → asserted JSON-safe output
- [x] 4.13 Multi-statement: fake driver returns two result arrays → handler returns only the last
- [x] 4.14 Zod validation: `Date` / `Uint8Array` / `BigInt` param rejected at worker boundary; empty string query rejected; non-positive `timeoutMs` rejected
- [x] 4.15 Cleanup: `sql.end({timeout:5})` awaited in `finally` on success and on error paths; `onRunFinished` forces close of any leaked handle
- [x] 4.16 Run `pnpm --filter @workflow-engine/sandbox-stdlib test` and confirm all pass

## 5. SDK wrapper tests

- [x] 5.1 Create `packages/sdk/src/sql.test.ts`; mock the `$sql/do` dispatcher
- [x] 5.2 Assert non-JSON param types throw `TypeError` before dispatch
- [x] 5.3 Assert the bridged payload preserves `connection`, `query`, and `params` verbatim for both string and object connection forms
- [x] 5.4 Assert the structured error envelope propagates `message` and `code` to the caller unchanged
- [x] 5.5 Run `pnpm --filter @workflow-engine/sdk test` and confirm all pass

## 6. Demo workflow integration

- [x] 6.1 Add `querySql` action to `workflows/src/demo.ts` targeting `postgres://reader:NWDMCE5xdipIjRrp@hh-pgsql-public.ebi.ac.uk:5432/pfmegrnargs?sslmode=require` (RNAcentral public Postgres)
- [x] 6.2 Inside `querySql`, run: a `SELECT 1 AS greeting` ping, a parameterized `SELECT upi FROM rna WHERE len = $1 LIMIT 5` with `params: [100]`, and an inner try/catch around a deliberate `SELECT bogus FROM nope` to exercise the `sql.error` path
- [x] 6.3 Wrap the entire `querySql` body in an outer try/catch returning `{skipped: true, reason}` so EBI downtime does not break `pnpm dev`
- [x] 6.4 Dispatch `querySql` from `runDemo` alongside the existing fetch/mail demos
- [x] 6.5 Add `executeSql` to the `_sdkSurface` static-reference block in `demo.ts` so any SDK-boundary rename breaks `pnpm build`

## 7. SECURITY.md updates

- [x] 7.1 Extend §2 R-S4's outbound-TCP list to include `createSqlPlugin` alongside `createFetchPlugin` and `createMailPlugin`
- [x] 7.2 Add a new §2 rule: "`sql.request` events MAY include `query` text but MUST NOT include param values; `logInput` emits `paramCount` only"
- [x] 7.3 Add a §2 R-4 entry naming `createSqlPlugin`: `sql.end({timeout:5})` in the per-call `finally` plus `onRunFinished` backstop forcing `sql.end({timeout:0})` on leaked handles
- [x] 7.4 Add a brief note alongside the R-S4 extension: "`sql.unsafe(query, params)` is the porsager/postgres label for the raw-string API; with `$N` placeholders and a non-empty params array it is parameterized and injection-safe (extended protocol). The plugin does not expose tagged-template authoring."

## 8. CLAUDE.md upgrade notes

- [x] 8.1 Add an additive entry under `## Upgrade notes` documenting the `executeSql` rebuild-and-re-upload path, naming the new event kinds `sql.request` / `sql.response` / `sql.error`, and noting no state wipe

## 9. Validation

- [x] 9.1 `pnpm validate` passes (lint + typecheck + vitest; WPT excluded)
- [x] 9.2 `pnpm exec openspec validate add-sql-plugin --strict` passes
- [x] 9.3 Review `git diff` for any accidental changes to fetch/mail plugins, dashboard CSS, runtime config, or infrastructure files (expected: none)

## 10. Dev-probe verification

- [x] 10.1 `pnpm dev --random-port --kill` boots; stdout contains `Dev ready on http://localhost:<port> (owner=dev)`
- [x] 10.2 `POST /webhooks/dev/demo/fireCron` with an empty body → 202; tail `.persistence/` for the event stream and confirm paired `invocation.started` / `invocation.completed` bracketing the `querySql` action
- [x] 10.3 In the same event stream confirm a `sql.request` / `sql.response` pair with `input.host = "hh-pgsql-public.ebi.ac.uk"`, `input.query` present, no param value `100` anywhere in either event payload
- [x] 10.4 In the same event stream confirm a `sql.error` event carrying `{message, code: "42601"}` (syntax error) from the deliberate-bad-SQL probe
- [x] 10.5 `GET /dashboard` with the local session cookie for owner `dev` → 200; HTML contains an entry rendered with `kind-fetch` styling whose label matches `sql to hh-pgsql-public.ebi.ac.uk/pfmegrnargs`
- [x] 10.6 Verify the `kind-fetch` class is applied to the `sql.*` dashboard entries (no new CSS class should exist; the change should have added zero styling)
- [x] 10.7 Kill the dev process tree when done
