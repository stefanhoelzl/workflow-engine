## Context

The archived `replace-duckdb-with-libsql` change swapped the event-store + per-workflow queues onto libSQL **embedded on disk** and explicitly deferred the remote-service (Bunny Database) work: `DATABASE_URL`/auth-token config, cold-start read retries, remote single-writer treatment, and the Bunny env/secret wiring (archived `design.md` Open Questions / D7). libSQL was chosen precisely so that "the later remote-Bunny change is a pure connection-config flip" (archived D1/D2). The seam is already in place: `main.ts` builds one `@libsql/client` and injects it into two `LibsqlDialect` Kysely instances (one per store); remote is the same dialect with a `libsql://` URL + `authToken`.

This change lands the **preparation** only. Bunny Database is in public preview; nothing here points a live environment at it. The goal is that pointing prod/staging at Bunny later requires setting env vars and nothing else.

Current relevant state:
- `config.ts` parses env via Zod, sealing secrets through `.transform(createSecret)` (e.g. `GITHUB_OAUTH_CLIENT_SECRET`, `SECRETS_PRIVATE_KEYS`). `PERSISTENCE_PATH` is a plain required string that today roots both the DB file **and** the tenant bundle store.
- `main.ts` builds `createClient({ url: file:${PERSISTENCE_PATH}/events.db })`, runs `PRAGMA journal_mode=WAL`, then wraps it in `eventDb`/`queueDb` Kysely instances.
- The **read path is decentralized**: `EventStore.query(scopes)` returns a Kysely builder that consumers (`ui/invocations/middleware.tsx`, `ui/invocations/removed-triggers.ts`) execute at ~8 sites. Only the **commit** path has retry/backoff.
- Staging already runs on Bunny Magic Containers with an embedded `events.db` on a `/data` accept-loss volume; prod is still the Scaleway VPS.

## Goals / Non-Goals

**Goals:**
- A single, required `DATABASE_URL` connection seam plus a sealed `DATABASE_AUTH_TOKEN` and an embedded-only `DATABASE_WAL` toggle, so remote vs embedded is selected by config alone.
- Refactor `main.ts` to build the client from `DATABASE_URL` via a `{ authToken } | { wal }` union, keeping the single-shared-client topology unchanged.
- Make every embedded boot path (infra staging, infra prod, dev, test/e2e) satisfy the now-required `DATABASE_URL` while staying on `file:`.
- Document the remote single-writer reality and the cutover/flip runbook so the future switch is env-only.

**Non-Goals:**
- Switching any environment to a remote Bunny Database, or provisioning a Bunny Database resource.
- Cold-start read-path retry, per-attempt timeouts, or any read-path resilience (deferred again — revisit if problems occur post-cutover).
- An app-level single-writer lease/fence.
- Exact-pinning the libSQL deps (caret ranges kept); SDK/sandbox-stdlib surface changes; event/queue schema changes; commit-retry changes.

## Decisions

### D1 — One required `DATABASE_URL`, no `PERSISTENCE_PATH` derivation
The libSQL connection comes from a single `DATABASE_URL` that may be `file:…` (embedded) or `libsql://…`/`https://…` (remote). It is **required** (`z.string()`); the previous `file:${PERSISTENCE_PATH}/events.db` derivation is removed. `PERSISTENCE_PATH` stays required for its other job (rooting tenant bundles via `createFsStorage`), but no longer implies the DB location. **Why:** one source of truth for the connection, and the remote flip is "set `DATABASE_URL`" with no hidden derivation to fight. **Alternatives rejected:** (a) optional-with-derivation default — keeps two sources of truth for the DB path; (b) scheme-sniffing a single var to *select* the mode — see D2, the scheme is intentionally not the selector.

**Fallout (accepted, BREAKING operator):** every boot path must now set `DATABASE_URL` or the runtime fails at config parse. This change therefore edits all embedded boot paths up front (D5).

### D2 — Three explicit env vars; `authToken` presence selects the builder variant
`DATABASE_URL`, `DATABASE_WAL` (string→bool, default `false`), `DATABASE_AUTH_TOKEN` (sealed, optional). The client builder takes a discriminated union `{ authToken: string } | { wal: boolean }`. Selection rule: **`DATABASE_AUTH_TOKEN` present ⇒ remote variant** (`createClient({ url, authToken })`, no pragma, no `mkdir`); **absent ⇒ embedded variant** (`createClient({ url })`, run `PRAGMA journal_mode=WAL` iff `wal`). **Why:** the env layer is fully explicit (no scheme parsing as a control-flow selector); the union keeps embedded/remote setup paths from interleaving. **Alternatives rejected:** scheme-sniffing as the selector (rejected in interview — couples control flow to URL string parsing); caller passing the variant from a separate mode flag (reintroduces a second source of truth that can disagree with the URL).

### D3 — Minimal validation: one contradiction guard, fail closed
A Zod `superRefine` errors at boot **only** when `DATABASE_AUTH_TOKEN` is set **and** `DATABASE_WAL=true` (asking for remote + an embedded-file pragma simultaneously). **Why:** that is the one combination that is internally contradictory regardless of scheme. **Explicitly not guarded (accepted footgun):** a `libsql://` URL with **no** token routes to the embedded `{wal}` variant and would attempt a local pragma against a remote URL; and a token alongside a `file:` URL is meaningless. These fail at connect/runtime rather than at boot. **Why minimal:** keeping the smallest validation surface was a deliberate call; the fuller scheme↔variant matrix (file⇒no-token, remote⇒token-required, wal-only-with-file) was considered and rejected to avoid over-fitting validation to preview-era assumptions.

`DATABASE_WAL` is parsed with a real string→bool (`z.stringbool`), **not** `z.coerce.boolean()` (which treats the string `"false"` as truthy).

### D4 — `DATABASE_WAL` default `false`; embedded boot paths opt in
The embedded WAL pragma is what lets out-of-process readers (the e2e harness's second connection per archived D9; operator tooling) read concurrently with the runtime's writes — without it, libSQL falls back to rollback-journal (`DELETE`) mode where writers block readers and concurrent readers hit `SQLITE_BUSY`. The default is `false` (explicit opt-in); every embedded environment sets `DATABASE_WAL=true` to retain today's concurrent-reader behaviour. **Why default `false` over `true`:** explicit per-environment intent was preferred over an implicit-on default. **Trade-off:** any embedded boot path that forgets `DATABASE_WAL=true` silently loses concurrent-read support — mitigated by editing all of them in D5 and asserting it in the e2e harness.

### D5 — Edit all embedded boot paths now, staying on `file:`
Because `DATABASE_URL` is required (D1), `bunny-staging.tf`, the VPS prod `apps.tf`, the `pnpm dev` bootstrap, and the test/e2e harness all set `DATABASE_URL=file:${PERSISTENCE_PATH}/events.db` + `DATABASE_WAL=true` in this change. All stay embedded; no Bunny resource is created. **Why now:** avoids a deploy-ordering hazard where a new image boots before infra supplies the required var. The `mkdir(dbRoot)` in `main.ts` is dropped — the DB directory is assumed to exist (the volume mount / `PERSISTENCE_PATH` dir, created by `storageBackend.init()`).

### D6 — Remote single-writer is a document-only deployment contract
Remote libSQL has **no file-level exclusion at all** — strictly weaker than embedded libSQL (archived D6: a file present but lock not acquired-at-open) and DuckDB (an exclusive open-lock). This change rewrites the `event-store` single-writer requirement (which currently defers remote as "out of scope, separate change") to state the remote reality and rest the guarantee entirely on the deployment shape: `autoscaling_min = autoscaling_max = 1`, `regions_max_allowed = 1`, and sequential rollout with no overlap window. An app-level lease/fence is named as a **future** option but not built. **Why not build it now:** there is no live remote instance to fence against, and the infra instance-count pin already covers the only realistic overlap window (rollout). **Alternative rejected:** building a lease row / advisory lock now — net-new runtime machinery with nothing to test against pre-cutover.

### D7 — No read-path retry; not mentioned in specs
`@libsql/client@0.8.1` offers no usable query-level retry (only opportunistic WebSocket reconnect on an already-closed socket, which ignores reconnect failures; the HTTP transport has none). A Bunny cold-start would surface as a failed dashboard query. Per the interview, this is **deferred again and left unmentioned** — no `executeRead` helper, no retry/timeout knobs, the read path is unchanged. Revisit only if cold-start failures are observed post-cutover.

### D8 — Single shared client; transport documented, not forced
The existing one-`createClient`-feeds-both-Kysely-stores topology is preserved for remote. Transport is left to `@libsql/client`'s URL-scheme choice (`libsql://` → WebSocket, `https://` → HTTP). The trade-off (a long-lived WS may be killed on idle spin-down; HTTP is stateless per request) is documented for the operator to decide via the URL at cutover; no transport is forced in code.

### D9 — Public-preview posture: keep caret ranges, document a pre-prod checklist
`@libsql/client` (`^0.8.0`) and `@libsql/kysely-libsql` (`^0.4.1`) keep their caret ranges. The preview risk is handled with a documented pre-prod verification checklist (cold-start latency, auth-token rotation, TLS/region, that the resolved client's Hrana protocol negotiates against Bunny) rather than a dependency pin.

### Builder selection flow

```
createConfig(env)
   │  DATABASE_URL (required), DATABASE_WAL (default false), DATABASE_AUTH_TOKEN (sealed?)
   │  superRefine: error iff authToken && wal===true            (D3)
   ▼
main.ts buildSqlClient(url, opts)
   │
   ├─ authToken present ──▶ { authToken }  ─▶ createClient({ url, authToken })   (remote, no pragma)
   │
   └─ authToken absent  ──▶ { wal }        ─▶ createClient({ url })
                                              └─ if wal: PRAGMA journal_mode=WAL  (embedded)
   ▼
one shared client ─▶ eventDb (Kysely<EventDatabase>)   ─▶ createEventStore
                  └▶ queueDb (Kysely<QueueDatabase>)   ─▶ createQueueStore
```

## Risks / Trade-offs

- **Required `DATABASE_URL` is a hard boot dependency (BREAKING)** → Edit all embedded boot paths in this change (D5); add an operator entry to `docs/upgrades.md`; the failure is a loud config-parse error, not silent.
- **`libsql://`-without-token footgun left unguarded (D3)** → Accepted to keep validation minimal; fails at connect/runtime. Documented in the flip runbook as the most likely cutover mistake.
- **`DATABASE_WAL=false` default can silently drop concurrent-read support (D4)** → All embedded boot paths set `WAL=true`; the e2e harness depends on it and asserts the concurrent reader works.
- **No remote read-path resilience (D7)** → Accepted; a Bunny cold-start surfaces as a failed dashboard query until the user retries. Revisit if observed.
- **Remote single-writer is assumed, not enforced, with no lock at all (D6)** → Infra pins instance count to 1 with sequential rollout; documented honestly. App-level lease deferred.
- **`DATABASE_URL` decoupled from `PERSISTENCE_PATH` could point the DB off-volume** → Documented operator caveat: keep the `file:` path under the persistent volume; tenant bundles still live under `PERSISTENCE_PATH`.
- **Public-preview API churn (caret ranges kept)** → Pre-prod checklist (D9); no live environment depends on Bunny in this change, so churn cannot break prod here.

## Migration Plan

1. Land config + `main.ts` builder + infra/dev/test env edits + spec deltas + docs. No dependency or schema change.
2. Deploy: the new image requires `DATABASE_URL`; infra already supplies `file:${PERSISTENCE_PATH}/events.db` + `DATABASE_WAL=true` (D5), so staging and prod boot embedded exactly as before. No data migration (same on-disk `events.db`).
3. `plan-infra` must be empty after the infra env additions are applied (operator runs `apply-infra`; agents surface the need in the PR summary).
4. **Future cutover (out of scope, documented runbook):** provision Bunny Database, set `DATABASE_URL=libsql://…` + `DATABASE_AUTH_TOKEN=…` (and drop/omit `DATABASE_WAL`) on staging first; verify against the pre-prod checklist; then prod. Rollback = revert the env vars to the `file:` values (data on the remote service is independent of the local volume; embedded resumes from the local `events.db`, which is accept-loss either way).

## Open Questions

None blocking. Deliberately deferred (not open, but tracked for the eventual cutover change): remote read-path retry/timeouts (D7), an app-level single-writer lease (D6), exact dependency pinning (D9), and the live Bunny Database provisioning + the actual env flip.
