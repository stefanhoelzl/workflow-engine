## ADDED Requirements

### Requirement: Queue plugin

The sandbox-stdlib package SHALL provide a `queue` plugin under `packages/sandbox-stdlib/src/queue/` that follows the existing system-bridge pattern (parallel to `sql` and `mail`):

- A guest-side IIFE that captures a private `$queue/do` `GuestFunctionDescription` and installs a locked-outer + frozen-inner global `__queue` with members `put` and `get`. The raw `$queue/do` descriptor SHALL be `public: false` and phase-3-deleted from guest scope.
- A worker-side handler that receives `(input: {op: "put"|"get", name: string, item?: unknown}, ctx)` and accesses `(owner, repo, workflow, queuesRoot, declaredQueues, validators)` from its descriptor `config`.
- A `dependsOn` declaration of `["web-platform"]`, matching `sql`/`mail`.
- An ESM `worker` re-export for the `?sandbox-plugin` vite transform.

The plugin SHALL emit `system.request` / `system.response` / `system.error` events with `name = "queue.put"` or `name = "queue.get"` via `ctx.emit` (R-5). Errors crossing the bridge SHALL be typed with `code` ∈ `{queue.itemTooLarge, queue.full, queue.schemaMismatch, queue.gone, queue.notDeclared}` and SHALL NOT leak host paths or filesystem errno values to the guest (R-13).

#### Scenario: Guest-visible global shape

- **WHEN** the sandbox completes plugin boot
- **THEN** `globalThis.__queue` SHALL exist as a non-writable, non-configurable property
- **AND** `__queue.put` and `__queue.get` SHALL be the only own properties
- **AND** `globalThis.$queue/do` SHALL NOT exist (phase-3-deleted)

#### Scenario: Worker honours declaredQueues

- **GIVEN** the plugin config's `declaredQueues = ["jobs"]`
- **WHEN** the worker receives `{op: "put", name: "ghost", item: {}}`
- **THEN** the worker SHALL throw `QueueNotDeclared` without touching the filesystem

### Requirement: Queue plugin durability

The queue plugin worker SHALL implement `put` as `open(path, "a") → write(line + "\n") → fsync(fd) → close(fd)` and SHALL NOT return success until `fsync` resolves. It SHALL implement `get` as: read the file (`O_NOFOLLOW`), split on `\n` and filter empty trailing entries, take the head, write the remainder to `path + ".tmp." + crypto.randomUUID()`, `fsync(tmpfd)`, `rename(tmp, path)`, `fsync(parentDir)`, then JSON-parse the head and validate it. The plugin SHALL NOT return the popped item to the guest until all fsyncs have resolved.

#### Scenario: Put waits for fsync

- **WHEN** the worker handles a `put` request
- **THEN** the worker SHALL `fsync(fd)` after the write
- **AND** the bridge response SHALL be sent only after `fsync` returns

#### Scenario: Get waits for both fsyncs

- **WHEN** the worker handles a `get` request that pops a non-empty queue
- **THEN** the worker SHALL `fsync(tmpfd)` before `rename` and `fsync(parentDir)` after `rename`
- **AND** the bridge response SHALL be sent only after the second fsync returns

#### Scenario: Symlink at queue path is refused

- **GIVEN** a symlink has been planted at the queue file path
- **WHEN** the worker attempts to `open` the path with `O_NOFOLLOW`
- **THEN** the open SHALL fail with `ELOOP`
- **AND** the worker SHALL surface the failure as `QueueGone`

### Requirement: Queue plugin per-run cleanup

The queue plugin SHALL hold no per-run host state — no timers, no in-flight callables, no open file handles, no pending fetches. Each `put` and each `get` SHALL be self-contained: open, do I/O, close, return. The plugin SHALL therefore comply with `SECURITY.md` §2 R-4 trivially, with no `onRunFinished` handler required.

#### Scenario: No state leaks across runs

- **GIVEN** the queue plugin has handled N puts and gets across multiple invocations
- **WHEN** the sandbox is inspected after `onRunFinished`
- **THEN** no file handles SHALL be held open by the worker
- **AND** no scheduled callbacks SHALL be pending
