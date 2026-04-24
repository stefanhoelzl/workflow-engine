## REMOVED Requirements

All requirements are absorbed into `sandbox` under a new "Sandbox consumer infrastructure (SandboxStore)" grouping. The SandboxStore is the runtime-internal mechanism for per-tenant, per-sha sandbox reuse; it exists to serve the sandbox capability rather than standing alone.

### Requirement: SandboxStore provides per-`(tenant, sha)` sandbox access

**Reason**: Runtime-internal reuse mechanism; belongs next to the sandbox lifecycle it extends.

**Migration**: See `sandbox` — same `SandboxStore` interface (`get(tenant, workflow, bundleSource): Promise<Sandbox>`, `dispose(): void`), same lazy-build-on-first-get contract, same per-tenant isolation guarantees (different tenants with identical shas get distinct sandboxes), same re-upload behaviour (new sha builds a new sandbox; old sandbox remains).

### Requirement: SandboxStore owns per-workflow `__hostCallAction` construction

**Reason**: Same absorption. This requirement is really about "plugin composition per cached `(tenant, sha)`"; it belongs alongside the plugin composition requirement in `sandbox`.

**Migration**: See `sandbox` — `createHostCallActionPlugin({ manifest })` added to the plugin list per sandbox; no dispatcher source appended; `createSdkSupportPlugin()` follows via `dependsOn`.

### Requirement: Sandboxes live for the lifetime of the store

**Reason**: Same absorption.

**Migration**: See `sandbox` — `dispose()` is the only eviction path; no per-sandbox eviction API; in-flight invocations complete on their existing sandbox even after re-upload registers a new sha.

### Requirement: SandboxStore is constructed with a factory and logger

**Reason**: Same absorption.

**Migration**: See `sandbox` — `createSandboxStore({ sandboxFactory, logger })` constructor shape; cache-miss logging via injected Logger.

### Requirement: SandboxStore composes full plugin catalog

**Reason**: Same absorption. The fixed composition order is the runtime-side contract for how sandbox-stdlib + runtime + sdk plugins fit together.

**Migration**: See `sandbox` — the ordered plugin catalog: `createWasiPlugin(runtimeWasiTelemetry)`, `createWebPlatformPlugin()`, `createFetchPlugin()`, `createTimersPlugin()`, `createConsolePlugin()`, `createHostCallActionPlugin({ manifest })`, `createSdkSupportPlugin()`, `createTriggerPlugin()`.

### Requirement: SandboxStore wires onEvent with metadata stamping

**Reason**: Same absorption. This is the runtime-side load-bearing point for SECURITY.md §2 R-8 (metadata stamping) and §1 I-T2 (tenant isolation).

**Migration**: See `sandbox` — `onEvent` callback on the store stamps `tenant`, `workflow`, `workflowSha`, `invocationId` onto every event before forwarding to the bus; gated-on-`trigger.request` `meta.dispatch` stamping is owned by the executor per R-9 (handled by `cleanup-specs-content`'s executor task).
