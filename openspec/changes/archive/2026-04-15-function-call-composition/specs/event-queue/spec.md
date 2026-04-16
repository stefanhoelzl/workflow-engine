## REMOVED Requirements

### Requirement: Event queue capability

**Reason**: The event queue concept (buffering events between trigger ingress and scheduler dispatch) is removed. The HTTP trigger middleware drives invocation lifecycle directly via the executor; there is no intermediate queue.

**Migration**: Remove any references to the event queue. The executor's per-workflow runQueue handles serialization but is internal and not a separately-specified capability.
