## ADDED Requirements

### Requirement: Queue plugin in production catalog

The runtime SHALL include the `queue` plugin in the production plugin catalog composed by `buildPluginDescriptors` in `packages/runtime/src/sandbox-store.ts`. The composer SHALL build a frozen config object `{owner, repo, workflow, queuesRoot, declaredQueues, validators}` per sandbox and pass it via `{...queuePlugin, config: queueConfig}`. `validators` SHALL be Ajv-compiled validator functions keyed by queue name, derived from the manifest's queue schemas. `queuesRoot` SHALL be the persistence path's `<root>/queues` subdirectory.

#### Scenario: Plugin composition

- **WHEN** `buildPluginDescriptors(workflow, keyStore)` runs for a workflow with two declared queues
- **THEN** the returned descriptor array SHALL contain an entry for the queue plugin
- **AND** that entry's `config` SHALL be a frozen object containing `declaredQueues` of length 2
- **AND** `validators` SHALL contain two compiled Ajv functions keyed by queue name

### Requirement: Globals enumeration includes __queue

The post-init guest globals enumeration test (per `SECURITY.md` §2 R-14) SHALL include `__queue` as a permitted own property of `globalThis`. The test SHALL fail if `__queue` is missing OR if any other queue-related property leaks into guest scope (e.g., a non-deleted `$queue/do`).

#### Scenario: Enumeration test passes for catalog with queue plugin

- **WHEN** the globals-surface test runs against a sandbox booted with the production catalog
- **THEN** `__queue` SHALL appear in the permitted globals list
- **AND** `$queue/do` SHALL NOT appear in `Object.getOwnPropertyNames(globalThis)`
