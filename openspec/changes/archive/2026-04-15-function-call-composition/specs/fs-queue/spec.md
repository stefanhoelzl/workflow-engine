## REMOVED Requirements

### Requirement: Filesystem-backed queue

**Reason**: There is no in-process work queue and therefore no filesystem-backed queue persistence beyond the invocation lifecycle records themselves. Persistence directly writes invocation pending/archive records (see `persistence` capability).

**Migration**: Remove fs-queue references. Invocation records under `pending/` and `archive/` are the only persisted state.
