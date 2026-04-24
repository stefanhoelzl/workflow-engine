## Context

The sandbox-stdlib package already ships two outbound-TCP plugins — `createFetchPlugin` (HTTPS) and `createMailPlugin` (SMTP) — both built around the same hardening primitive: resolve DNS once via `assertHostIsPublic`, connect to the validated IP, pin the original hostname as TLS SNI to close the DNS-rebinding / TOCTOU window (SECURITY.md §2 R-S4). Adding Postgres is a third instance of that pattern, not a new mechanism.

The driver choice is the one axis where SQL diverges from the fetch/mail precedent. Node's Postgres clients disagree about how socket creation is hooked:

- `pg` (node-postgres, ~24M weekly dl) exposes `config.stream` as a **sync** factory. Our `assertHostIsPublic` is async (it calls `dns.resolve4`), so plugging it into a sync factory requires overriding `Socket.prototype.connect` inside the factory — clever but awkward.
- `postgres` (porsager/postgres, ~7M weekly dl) exposes `options.socket(opts)` as an **async** factory (`await Promise.resolve(options.socket(options))`), explicitly designed for this pattern. It also has zero runtime dependencies and no optional native module.

The rest of the design flows from picking `postgres`.

The threat model for SQL differs from fetch in one important way already captured in the interview: the workflow author and the target database are co-owned. SQL injection is not a cross-tenant escalation vector here — an author writes queries against their own data. The plugin therefore supports arbitrary multi-statement queries and does not try to lift the "safe by construction" bar that tagged templates provide. Injection safety remains available (via `$N` placeholders bound through `sql.unsafe(query, params)`) as an ergonomics choice, not a security boundary.

## Goals / Non-Goals

**Goals:**

- Let workflow actions send arbitrary parameterized SQL to a Postgres server and receive rows back as JSON.
- Close the DNS-rebinding window with exactly the same guarantee fetch and mail provide.
- Keep the API shape stable as additional engines (MySQL, etc.) land later.
- Preserve the R-4 per-run cleanup discipline (no connection, timer, or query outlives a single `sb.run()`).
- Match the event shape/naming used by fetch and mail so operators reading the dashboard see a consistent IO log.
- Zero new runtime config, zero new K8s Secrets, zero infrastructure changes.

**Non-Goals:**

- MySQL, SQLite, MSSQL, or any non-Postgres engine at v1.
- Connection pooling across calls or across invocations.
- Streaming / cursor-based result pagination.
- Tagged-template authoring API (`` sql`SELECT ${x}` ``).
- Transactions that span multiple `executeSql` calls (authors can inline `BEGIN; …; COMMIT;` in one call).
- Author-facing or plugin-level result-size caps (no row/byte limit; author must `LIMIT` explicitly).
- `BigInt`, `Date`, or `Uint8Array` round-tripping across the sandbox bridge on either the input or output path.
- Operator allowlists of permitted DB hostnames.
- Dashboard theming changes — `sql.*` events reuse the `kind-fetch` styling.

## Decisions

### 1. Driver: `postgres` (porsager/postgres)

Compared to `pg`, porsager/postgres has:
- an **async** `socket` factory hook that makes `assertHostIsPublic` integration natural;
- zero runtime dependencies and no optional native module (smaller supply-chain surface and one fewer bundler footgun);
- official bundled TypeScript types;
- a `sql.unsafe(text, params)` path that gives us exactly the `(text, params[])` parameterized API we want; porsager's default automatically routes empty-`params` calls through Postgres's simple-query protocol (multi-statement allowed) and non-empty-`params` calls through the extended protocol (parameter binding).

`pg` wins on ubiquity and on having a built-in `statement_timeout` config option. The ubiquity argument is qualitative; the timeout argument is answered by sending `statement_timeout` as a Postgres startup parameter instead of a driver option (see Decision 4). The zero-deps, async-hook wins tip the scale.

### 2. DNS-rebinding hardening via the `socket` hook (not field override)

```
Guest                 SDK wrapper                 Plugin worker                       Postgres
─────                 ────────────                ─────────────                       ────────
executeSql(           Callable(                   postgres(connectionConfig, {
  conn,  ─────────▶     "$sql/do",     ─────────▶   socket: async (opts) => {
  query,                input)                         const ip =
  params                                                 await assertHostIsPublic(opts.host);
)                                                       return net.connect({ host: ip, port: opts.port });
                                                     },
                                                     ssl: sslWithPinnedServername,
                                                     connection: { statement_timeout: "<N>" },
                                                     max: 1,
                                                     prepare: false,
                                                   });
                                                   const rows =
                                                     await sql.unsafe(query, params);
                                                   return coerceRows(rows); ─────────▶   TCP+TLS via hardened socket
```

Rationale: `postgres` never re-resolves DNS once we hand it a connected socket, so the validated IP is the IP the driver uses. No second resolution anywhere in the stack. This is the structural analogue of fetch's `new net.Socket().connect(port, validatedIp)` and mail's `nodemailer.createTransport({ host: validatedIp, tls: { servername: hostname } })`.

Alternative considered: **pre-resolve + override `config.host` with the IP** (the "Option X" pattern fetch/mail use at field level). Works, but requires the plugin to own two config-field substitutions (`host`, `ssl.servername`) and contradicts the "map straight to the library interface" direction the user called out. The socket hook localises all the hardening inside one closure and leaves the author's config untouched except for the `servername` pin in Decision 3.

### 3. TLS SNI pin when author requests TLS

porsager's connection code auto-sets `servername: isIP(host) ? undefined : host`. Because our socket hook hands the driver a socket already connected to an IP, `postgres` would drop SNI entirely — breaking cert validation against hostname-signed certificates. The plugin therefore pins `ssl.servername = originalHostname` whenever `ssl` is truthy:

```ts
ssl: authorSsl && {
  ...(typeof authorSsl === "object" ? authorSsl : {}),
  servername: originalHostname,
}
```

The plugin does **not** otherwise touch `ssl.ca`, `ssl.cert`, `ssl.key`, or `ssl.rejectUnauthorized` — those pass through verbatim, letting authors supply inline PEMs for private CAs or mTLS.

### 4. Query timeout via Postgres `statement_timeout` startup parameter

`postgres` has no built-in per-query timeout and does not accept an `AbortSignal`. Options considered:

- **Racing `setTimeout` with a socket-destroy** — works, but leaks a server-side backend until the server's own defaults reap it.
- **Explicit `SET statement_timeout` on first query** — two round-trips per call.
- **Prepending `SET ...; <userQuery>`** — single round-trip but the plugin would be concatenating SQL, muddying `sql.request.input.query` content and audit readability.
- **Startup parameter: `postgres(url, { connection: { statement_timeout: "<N>" } })`** — the driver sends it in the Postgres startup message alongside auth. Server aborts any statement exceeding it, driver receives a standard error with SQLSTATE `57014`. Single channel, zero extra round-trips, server-side enforcement.

We use the startup parameter. `connect_timeout` (seconds) covers the DNS+TCP+TLS+auth phase that `statement_timeout` does not. The plugin hard-caps `timeoutMs` at 120s and defaults to 30s when `options.timeoutMs` is unset — matching fetch's 30s wall-clock budget.

### 5. Per-call connect / disconnect; `sql.end` in `finally`

`postgres` is pool-first (`max`, `idle_timeout`, `max_lifetime`). For this plugin we force `max: 1, prepare: false` and call `sql.end({ timeout: 5 })` in the per-call `finally`. No cross-call state, no prepared-statement cache that needs invalidation across configurations, and `onRunFinished` becomes a pure backstop that iterates any leaked handles and forces `sql.end({ timeout: 0 })`.

### 6. Sandbox bridge: JSON in, JSON out — no value-type encoding

Params are restricted to `string | number | boolean | null`. No `Date`, no `Uint8Array`, no `BigInt`. Authors encode at the call site (`ISO string`, base64 string, decimal string). This removes an entire encoding layer from the SDK wrapper and the worker Zod schema.

Rows returned to the guest are pure JSON. The plugin worker applies a fixed type-coercion table to the values `postgres` hands back before reply:

| Postgres type | Wire value |
|---|---|
| `int2`, `int4`, `float4`, `float8`, `numeric` fitting f64 | `number` |
| `int8`, large `numeric` | `string` (decimal) |
| `bool` | `boolean` |
| `text`, `varchar`, `char`, `uuid`, `name` | `string` |
| `timestamp`, `timestamptz`, `date`, `time`, `timetz` | `string` (ISO-8601) |
| `bytea` | `string` (base64) |
| `json`, `jsonb` | parsed object |
| arrays | recursive |
| composite / range / geometric | `string` (pg text form) |
| `NULL` | `null` |

No `Date` instances, `Buffer`s, or `BigInt`s cross the bridge. `ColumnMeta` carries `{ name, dataTypeID }` so authors who need a `Date` can reconstruct one.

### 7. Multi-statement queries, last result only

`sql.unsafe(query, params)` uses Postgres's simple-query protocol when `params` is empty (the driver's default), which returns all result sets for a multi-statement query; the plugin keeps the **last** result set's `rows`/`columns`/`rowCount` and discards earlier ones. When `params` is non-empty, the extended protocol is used — it supports parameter binding but rejects multi-statement queries at the server. Either way the return shape is a single flat object. This matches the user-chosen contract "allow everything, user gets back a table of data" while respecting the mutually-exclusive constraints of the two wire protocols.

### 8. Event shape parity with fetch/mail

Three kinds: `sql.request` (createsFrame), `sql.response` (closesFrame), `sql.error` (closesFrame). Routed through `ctx.request`'s auto-wrap.

`sql.request.input`: `{ engine: "postgres", host, database, query, paramCount }`. Param *values* never appear in any event — the descriptor's `logInput` explicitly returns `paramCount` only. Connection password, when sourced from author config, is a plain string (no Secret wrapping is required because the plugin does not log it; if a future change adds logging, the Secret wrapper pattern from `packages/runtime/src/config.ts` applies).

`sql.response.output`: `{ rowCount, durationMs }`. No rows logged.

`sql.error.output`: `{ message, code? }` — flat, with `code` set to Postgres SQLSTATE when the server responded (e.g. `"57014"` for statement_timeout, `"28P01"` for auth failure), absent for client-side failures (DNS blocked, TCP/TLS failure).

`logName` renders as `sql to <host>/<database>`. Dashboard reuses `kind-fetch` CSS.

### 9. Test strategy: vitest mocks, following `mail.test.ts`

`vi.mock("node:dns/promises")` to control what `assertHostIsPublic` resolves. `vi.mock("postgres")` to intercept the driver factory and capture what options the plugin passed. The test surface:

- **Hardening**: RFC-1918 / IANA-reserved rejection, validated-IP substitution in the socket factory, `servername` pinning when connecting to an IP.
- **Driver call shape**: `statement_timeout` value and ceiling, `connect_timeout`, `max:1`, `prepare:false`, `sql.unsafe` arity and `simple:true`.
- **Event shape**: `sql.request` includes `paramCount` but not param values; `sql.error` flat `{message, code?}`.
- **Row coercion**: the table above, fed via fake driver output.
- **Zod validation**: non-JSON params rejected, empty query rejected, non-positive `timeoutMs` rejected.
- **Cleanup**: `sql.end` called in `finally` on success and on error.

No live Postgres in the unit suite. The demo.ts `querySql` probe hitting RNAcentral (`hh-pgsql-public.ebi.ac.uk`) is the single live end-to-end smoke, wrapped in try/catch so upstream downtime does not break `pnpm dev`.

## Risks / Trade-offs

- **Author `SELECT *` can OOM the plugin worker.** → Accepted. The per-call connection model isolates the blast radius to that single run; other invocations are unaffected. Documented in the SDK JSDoc for `executeSql` and in the upgrade notes. No plugin-level byte cap.
- **`sql.unsafe`'s name looks alarming in code review.** → Mitigated via an in-file comment and a SECURITY.md note: the method is parameterized and injection-safe when called with `$N` placeholders + a params array; the name is porsager's terminology, not a safety warning.
- **porsager/postgres is less ubiquitous than `pg`.** → Accepted. Zero runtime deps and the async socket hook are the tiebreakers for this use case. If a future change needs `pg` (e.g. for a different plugin), both can coexist — they don't share state.
- **No built-in per-query `AbortSignal`.** → Mitigated by `statement_timeout` startup param. If a future requirement needs mid-query cancellation from the host side, we add `pg_cancel_backend` via a second connection then; for now, server-side reaping is sufficient given per-call connections.
- **External demo target (RNAcentral) may go down.** → Mitigated by a try/catch around the demo action so `pnpm dev` bootstrap never fails; the action simply records a "skipped" result.
- **Tagged-template authoring is not offered.** → Accepted. The user explicitly wanted "send arbitrary SQL, get table back", and multi-statement queries require simple protocol, which porsager's tagged template does not use. If a future spec wants `sql\`…\``, it's additive.

## Migration Plan

Additive, no state wipe, no breaking changes. Rollout:

1. Ship the spec deltas and code.
2. Tenants rebuild via `pnpm build` and re-upload with `wfe upload --owner <name>` to pick up `executeSql`.
3. Tenants not using SQL observe zero behavioural change.
4. Rollback: revert the PR. Persisted event history keeps any emitted `sql.*` events as-is; they flow through the unchanged event pipeline and render in the dashboard with the default `kind-fetch` styling whether or not the plugin is installed.

## Open Questions

None at design time. All interview threads (driver choice, hardening mechanism, timeout mechanism, result coercion, param type surface, test strategy, event shape, SECURITY.md deltas, demo target) are closed.
