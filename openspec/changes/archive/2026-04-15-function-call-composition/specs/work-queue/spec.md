## REMOVED Requirements

### Requirement: WorkQueue implements BusConsumer with dequeue

**Reason**: The work queue (an in-memory buffer of pending events fed from the bus and drained by the scheduler) is removed. There is no scheduler loop; HTTP triggers invoke the executor directly. Per-workflow serialization happens via a tiny in-process Promise-chain `runQueue` inside the executor — not a bus consumer.

**Migration**: Remove WorkQueue from runtime initialization and from the bus consumer list. Per-workflow serialization is internal to the executor.

### Requirement: handle() buffers only pending events

**Reason**: No buffering, no events.

**Migration**: N/A — WorkQueue is gone.

### Requirement: dequeue() blocks until event available

**Reason**: No dequeue path; the executor invokes handlers synchronously per HTTP request.

**Migration**: N/A — WorkQueue is gone.
