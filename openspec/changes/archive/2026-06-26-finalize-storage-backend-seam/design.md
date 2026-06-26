## Context

`StorageBackend` already exists (`packages/runtime/src/storage/index.ts`) and workflow tarballs already flow through it: `WorkflowRegistry` calls `list("workflows/")` + `read(key)` on boot recovery and `write(key, bytes)` on upload. The lone implementation, `createFsStorage`, is constructed and `init()`-ed directly in `main.ts`. EventStore/QueueStore reach libSQL directly via `DATABASE_URL` and do **not** use this interface.

A working bundle-only S3 backend (`s3.ts`, ~100 lines, AWS SDK with custom-endpoint support) existed historically and was deleted in `498ae0ba` as collateral of removing *events* from object storage (the DuckLake teardown). The lesson was explicit: events-on-object-storage was painful; bundles never were. This change prepares the seam for that bundle-only future without reintroducing any remote code.

The canonical `storage-backend` spec was reconciled to current reality in a prior commit (no more `locator()`/S3/DuckLake drift), so this change builds on a clean base.

## Goals / Non-Goals

**Goals:**
- A future S3/Bunny bundle backend is a pure addition: implement `write`/`read`/`list`, register it in the factory, done — no `main.ts` surgery.
- The contract a future backend must satisfy is written down and executable (conformance suite).
- Backward compatible: existing fs deployments behave identically with no new required config.

**Non-Goals:**
- No remote (S3/Bunny) implementation ships. No new dependencies.
- Events/queues (libSQL) stay on local disk — not routed through `StorageBackend`.
- No `delete`/`exists` methods (no caller today; YAGNI).
- No streaming API — bundles are small (KB); `read`/`write` stay full-buffer `Uint8Array`.

## Decisions

### 1. `init()` folds into an async factory

`createFsStorage(root)` becomes `async` and returns an already-initialized backend (does its own `mkdir -p`; a future remote does a fail-fast credentials/connectivity probe). `init()` leaves the `StorageBackend` interface, which narrows to `write`/`read`/`list`.

- **Why:** `init()` as a separate interface method is forgettable (every caller must remember to call it) and is a construction concern, not a data operation. An async factory makes initialization unskippable and fails fast at boot on bad config.
- **Alternative considered:** keep `init()` as a lifecycle method. Rejected — it leaves a foot-gun on the interface and an extra step in `main.ts` for no benefit.

### 2. Config-driven `createStorage(config)` factory + `STORAGE_BACKEND` env

`main.ts` constructs the backend via a new async `createStorage(config)` that dispatches on `config.storageBackend` (from `STORAGE_BACKEND`, default `"fs"`). Only `fs` is registered; an unknown value throws at boot.

- **Why:** moves backend selection to config so a future backend is `register + done`, and proves the wiring now. Fail-fast on unknown values prevents a silent misconfiguration.
- **Alternative considered:** the historical pattern (presence of `PERSISTENCE_S3_BUCKET` implicitly selects S3). Rejected — an explicit discriminator is clearer and avoids ambiguous multi-var precedence.

### 3. Typed `NotFoundError` on read miss

`read()` of a missing key throws a sentinel `NotFoundError`. The fs backend maps `ENOENT` to it; a future S3/Bunny backend maps its 404. `WorkflowRegistry.recover()` catches it as a benign list→read race (log + skip) rather than crashing.

- **Why:** a backend-agnostic miss signal lets callers branch on one type instead of fs-specific `ENOENT` or SDK-specific 404 shapes.
- **Alternative considered:** `read()` returns `Uint8Array | null`. Rejected — pushes a null-check onto every call site and is easy to forget; an exception is the right shape for "the key you asked for isn't there."

### 4. Capability re-scope + written future-backend contract

The `storage-backend` capability is framed around the `workflows/` keyspace it actually governs, plus a normative contract section: `write` atomically replaces (no torn reads), `read` throws `NotFoundError` on miss, keys are opaque forward-slash-delimited strings, `list` order is unspecified. A backend-agnostic conformance suite encodes the testable parts and runs against `fs`.

- **Why:** the contract is the real deliverable of a "seam-only" change — it's what a future author implements against. Running it against `fs` keeps it honest today; a future backend runs the same suite.
- **`.tmp` decision:** `fs.list` filters `*.tmp` so a crashed write (tmp written, rename not yet done) can never surface an uncommitted key — keeps the "list yields only committed keys" contract true across backends (object stores have no such artifact).

## Risks / Trade-offs

- **[Speculative surface — `NotFoundError` has only a defensive caller today]** → It's cheap, enforced by the conformance suite, and removes a real fs-vs-404 branching problem for the first remote backend. Accepted.
- **[Conformance suite runs against only one backend (`fs`)]** → It can't prove a *non*-fs impl conforms until one exists, but it pins the contract and is the exact harness a future backend runs. Accepted per scope (no second backend built now).
- **[Async factory changes `main.ts` construction ordering]** → Contained: only the bundle backend is affected; EventStore already takes `persistenceRoot` directly. Low risk.
- **[`read()` now throwing a typed error instead of raw `ENOENT`]** → Only caller is `recover()`, updated to tolerate it. No external API change.

## Migration Plan

- Backward compatible. `STORAGE_BACKEND` defaults to `"fs"`; unset behaves exactly as today. `PERSISTENCE_PATH` semantics unchanged. No data migration, no operator action required. Rollback is a code revert — on-disk layout is untouched.
