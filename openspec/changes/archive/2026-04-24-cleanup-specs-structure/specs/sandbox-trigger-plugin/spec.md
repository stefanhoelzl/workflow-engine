## REMOVED Requirements

All requirements are absorbed into `triggers` under a new "Trigger plugin (in-sandbox lifecycle emission)" grouping.

### Requirement: createTriggerPlugin factory

**Reason**: The trigger plugin's `onBeforeRunStarted` / `onRunFinished` hooks ARE the lifecycle emission mechanism for the `triggers` capability. Splitting it into its own spec duplicates ownership.

**Migration**: See `triggers` — the factory contract (emits `trigger.request` with `createsFrame: true` before guest export; emits `trigger.response` or `trigger.error` with `closesFrame: true` after) is specced there with every scenario preserved (request/response pair, guest-throw → trigger.error, nested events inherit `trigger.request.seq` as parent ref).

### Requirement: Trigger is optional

**Reason**: Same absorption.

**Migration**: See `triggers` — a sandbox composition without `createTriggerPlugin()` SHALL still execute runs but SHALL emit no `trigger.*` events. Valid for tests and silent-run use cases.

### Requirement: Reserved trigger prefix

**Reason**: Same absorption. The reservation is plugin-author discipline (not enforced at emit time) per SECURITY.md §2 R-7.

**Migration**: See `triggers` — `trigger.` is one of the reserved event-kind prefixes; no other plugin emits events starting with `trigger.`.
