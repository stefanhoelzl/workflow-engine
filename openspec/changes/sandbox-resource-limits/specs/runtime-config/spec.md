## ADDED Requirements

### Requirement: Sandbox resource-limit config fields

The runtime config schema in `packages/runtime/src/config.ts` SHALL define five sandbox resource-limit fields, each sourced from an environment variable and coerced to a positive integer. Defaults SHALL live in the zod schema via `.default(...)`; no Dockerfile `ENV` line SHALL set these values. Operators override the defaults by setting the corresponding environment variable in K8s manifests.

The fields SHALL be:

| Env variable | Zod shape | Default | Meaning |
|---|---|---|---|
| `SANDBOX_LIMIT_MEMORY_BYTES` | `z.coerce.number().int().positive().default(67_108_864)` | 64 MiB | QuickJS heap cap per sandbox |
| `SANDBOX_LIMIT_STACK_BYTES` | `z.coerce.number().int().positive().default(524_288)` | 512 KiB | QuickJS `maxStackSize` per sandbox |
| `SANDBOX_LIMIT_CPU_MS` | `z.coerce.number().int().positive().default(60_000)` | 60 s | Wall-clock cap per `sandbox.run()` |
| `SANDBOX_LIMIT_OUTPUT_BYTES` | `z.coerce.number().int().positive().default(4_194_304)` | 4 MiB | Cumulative event-stream bytes per run |
| `SANDBOX_LIMIT_PENDING_CALLABLES` | `z.coerce.number().int().positive().default(64)` | 64 | Concurrent in-flight host-callables per run |

The runtime's `main.ts` SHALL thread these values into the sandbox factory's `create({ memoryBytes, stackBytes, cpuMs, outputBytes, pendingCallables, ... })` options. No call site outside `main.ts` SHALL read these env vars directly from `process.env`.

The config fields SHALL NOT be wrapped with `createSecret` (they are non-secret operational limits; see the auditability carve-out under the existing `AUTH_ALLOW` requirement).

#### Scenario: Defaults apply when env vars are unset

- **GIVEN** a runtime process started with none of the `SANDBOX_LIMIT_*` env vars set
- **WHEN** `loadConfig()` is called
- **THEN** the returned config SHALL carry `SANDBOX_LIMIT_MEMORY_BYTES = 67108864`, `SANDBOX_LIMIT_STACK_BYTES = 524288`, `SANDBOX_LIMIT_CPU_MS = 60000`, `SANDBOX_LIMIT_OUTPUT_BYTES = 4194304`, `SANDBOX_LIMIT_PENDING_CALLABLES = 64`

#### Scenario: Env-var override replaces default

- **GIVEN** a runtime process started with `SANDBOX_LIMIT_CPU_MS=5000`
- **WHEN** `loadConfig()` is called
- **THEN** the returned config SHALL carry `SANDBOX_LIMIT_CPU_MS = 5000`

#### Scenario: Non-positive value rejected

- **GIVEN** a runtime process started with `SANDBOX_LIMIT_MEMORY_BYTES=0` or `SANDBOX_LIMIT_MEMORY_BYTES=-1`
- **WHEN** `loadConfig()` is called
- **THEN** the schema SHALL reject the value and startup SHALL fail with a clear error message

#### Scenario: Non-numeric value rejected

- **GIVEN** a runtime process started with `SANDBOX_LIMIT_CPU_MS=abc`
- **WHEN** `loadConfig()` is called
- **THEN** the schema SHALL reject the value and startup SHALL fail
