## Why

Action authors today can reach HTTP services via `fetch` and SMTP servers via `sendMail`, but have no first-class way to query a relational database. Workflows that want to read from or write to Postgres must either proxy through an external HTTP shim or skip SQL-backed use cases entirely. Adding a hardened SQL capability to the sandbox-stdlib plugin set unlocks a large class of integration workflows (sync/transform/report/notify against an operator's own Postgres) without widening the sandbox threat model beyond what fetch and mail already accept.

## What Changes

- New `executeSql(connection, query, params?, options?)` export on the SDK that sends parameterized SQL to a Postgres server and returns JSON-safe rows.
- New sandbox-stdlib plugin `createSqlPlugin` (package `@workflow-engine/sandbox-stdlib`, path `src/sql/`) that installs the `$sql/do` host-callable descriptor, routes outbound TCP through the existing `assertHostIsPublic` net-guard primitive, and uses the `postgres` (porsager/postgres) driver under the hood via `sql.unsafe(query, params, { simple: true })`.
- New event kinds `sql.request` / `sql.response` / `sql.error` flowing through the existing EventBus pipeline unchanged.
- `workflows/src/demo.ts` gains a `querySql` action probing the public RNAcentral Postgres (`hh-pgsql-public.ebi.ac.uk`) to exercise the plugin end-to-end in `pnpm dev` and `pnpm local:up:build`, wrapped so upstream downtime does not break the dev boot.
- `SECURITY.md` §2 updates: R-S4 gains `createSqlPlugin` in its outbound-TCP list; new rule naming `query` text loggable but param *values* prohibited in `sql.request` events; R-4 cleanup entry for per-call connection teardown via `sql.end`.
- `CLAUDE.md` `## Upgrade notes` gains an additive entry describing the `executeSql` rebuild-and-re-upload path; no state wipe.

## Capabilities

### New Capabilities

_None — the SQL plugin lives inside the existing `sandbox-stdlib` capability alongside fetch and mail._

### Modified Capabilities

- `sandbox-stdlib`: adds the `createSqlPlugin` factory requirement, the hardened-egress requirement, and the event-emission requirement for `sql.request` / `sql.response` / `sql.error`.
- `sdk`: adds the `executeSql` export requirement with its `Connection` / `Param` / `SqlResult` shapes.

## Impact

- **Code**: new `packages/sandbox-stdlib/src/sql/{index,worker,types,descriptor-name,sql.test}.ts`; new `packages/sdk/src/sql.ts` with re-export from `packages/sdk/src/index.ts`; runtime registers the new plugin in its sandbox-plugin composition (same location as mail).
- **Dependencies**: adds `postgres` (porsager/postgres, zero runtime deps) to `packages/sandbox-stdlib/package.json`. No native modules, no transitive supply-chain growth.
- **Events**: three new kinds registered in `packages/core/src/index.ts`. Dashboard reuses existing `kind-fetch` styling — no CSS changes.
- **Config / secrets**: none. All connection details are supplied per-call by the workflow author; no new runtime env vars, no new K8s Secrets, no new Zod schemas in `packages/runtime/src/config.ts`.
- **Infrastructure**: none. No Traefik, cert-manager, NetworkPolicy, or Helm changes. Hardened egress is enforced in-process by `assertHostIsPublic` exactly as fetch and mail do it.
- **Security**: net-guard surface widens by one consumer (`createSqlPlugin`); no weakening of any existing invariant. SECURITY.md deltas as listed above.
- **Breaking changes**: none. Purely additive.
