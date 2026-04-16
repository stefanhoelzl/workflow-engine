## REMOVED Requirements

### Requirement: Concurrent processing

**Reason**: There is no global concurrency limit. Per-workflow serialization (one trigger invocation at a time per workflow) is the only concurrency control in v1; cross-workflow concurrency is unbounded by Node's HTTP server. Both are managed inside the executor's per-workflow runQueue, not by a scheduler.

**Migration**: No author action required; HTTP server bounds total in-flight requests.

### Requirement: Processing lifecycle

**Reason**: There is no scheduler loop dequeuing events from a WorkQueue. The HTTP trigger middleware drives invocation lifecycle directly via `executor.invoke(workflow, trigger, payload)`, which awaits the handler's return value and shapes it into the HTTP response.

**Migration**: Replace any scheduler-driven dispatch with `executor.invoke(...)` from the HTTP trigger middleware.

### Requirement: Fan-out for undirected events

**Reason**: There are no events and no fan-out. Parallel side effects are expressed as `Promise.all([...])` in handler code.

**Migration**: Replace fan-out subscribers with explicit parallel calls.

### Requirement: Sandbox reused across events for the same source

**Reason**: One sandbox per workflow is preserved (see `workflow-loading` capability), but the unit of dispatch is no longer "events for the same source" — it is "trigger invocations for the same workflow." The reuse property is preserved at the workflow level.

**Migration**: The reuse semantics survive at workflow granularity; per-event-source caching is gone.

### Requirement: Dead sandbox is transparently replaced

**Reason**: Replaced by the same mechanism in the new model — the sandbox factory transparently respawns dead sandboxes — but lives outside the scheduler (in the workflow registry / sandbox factory).

**Migration**: No author action required.
