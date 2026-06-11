## MODIFIED Requirements

### Requirement: Per-Quadlet resource ceilings

Every app Quadlet unit SHALL enforce its memory budget as a hard cap on the container **payload** cgroup via `PodmanArgs=--memory=<budget>` (Quadlet's `Memory=` key is unsupported on Podman 5.4.2), so the limit is visible from inside the container at `/sys/fs/cgroup/memory.max`. App units SHALL NOT declare a `[Service]`-section memory key (`MemoryMax=`/`MemoryHigh=`): a parent-cgroup limit is invisible from inside the container, so memory-auto-sizing software (DuckDB sizes its buffer pool to 80 % of detected memory; V8 sizes its heap similarly) sizes against host RAM and overruns the cap — and because payload usage charges up to the parent, a parent cap alongside the payload cap would trip first and restore the systemd-kill semantics this requirement exists to avoid.

The Caddy unit SHALL declare `MemoryMax=` — no memory-auto-sizing software runs inside it, so a parent-level ceiling is sufficient.

Values SHALL be sized so the sum across all units, plus a kernel + page-cache reserve of at least 256 MB, does not exceed the VPS's physical RAM. (`CPUQuota=` is not currently set; STARDUST1-S has 1 shared vCPU and CPU contention has not been observed to cause issues — add per-unit quotas if a noisy-neighbour symptom appears.)

#### Scenario: A runaway workload does not OOM its neighbour

- **GIVEN** the units have started with their declared memory budgets
- **WHEN** one app instance consumes memory beyond its `--memory` cap
- **THEN** the kernel SHALL OOM-kill within that unit's payload cgroup only
- **AND** the other app instance and Caddy SHALL continue running

#### Scenario: Memory budget is visible inside the container

- **GIVEN** an app unit has started with its declared `--memory` budget
- **WHEN** `/sys/fs/cgroup/memory.max` is read from inside the container
- **THEN** it SHALL equal the configured budget in bytes (e.g. `367001600` for `350m`), not `max`
