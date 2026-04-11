## Context

The infrastructure currently lives in `infrastructure/dev/` with routing (Traefik Helm + IngressRoute CRDs) nested inside the workflow-engine module as a submodule. This tightly couples routing deployment to the workflow-engine module, preventing reuse across environments. We need to make modules reusable so a future UpCloud production environment can share them.

Current module structure:
```
infrastructure/dev/dev.tf
  └─ module.workflow_engine (modules/workflow-engine/)
       ├─ module.app
       ├─ module.oauth2_proxy
       └─ module.routing (modules/workflow-engine/modules/routing/)
            └─ helm_release.traefik (chart + CRDs as extraObjects)
```

## Goals / Non-Goals

**Goals:**
- Rename `infrastructure/dev/` to `infrastructure/local/` to distinguish from future cloud environments
- Extract routing into a top-level parameterized module that any environment can use
- Have workflow-engine output its route definitions (CRDs) so the root config wires them into routing
- Zero infrastructure impact — validated by `tofu plan` comparison

**Non-Goals:**
- Adding the UpCloud production environment (Phase 2)
- Changing the kubernetes/kind module outputs (kept as-is: `host`, `cluster_ca_certificate`, `client_certificate`, `client_key`)
- Modifying any application code or runtime behavior
- Updating `openspec/specs/infrastructure/spec.md` (follow-up)

## Decisions

### 1. Routing module becomes a thin Traefik Helm wrapper

The new `modules/routing/routing.tf` accepts two inputs:
- `traefik_extra_objects` (`type = any`) — list of CRD objects (Middlewares, IngressRoutes)
- `traefik_helm_sets` (`type = list(object({ name = string, value = string }))`) — env-specific Helm set values

The module deploys the Traefik Helm chart with these parameters. It has no knowledge of routes, services, or authentication — just Helm deployment.

**Why `type = any` for extra_objects:** CRD manifests are deeply nested, heterogeneous structures. A precise type would cause `yamlencode` type coercion (e.g., numbers → strings), breaking plan determinism. `any` preserves types exactly.

**Alternative considered:** Passing pre-rendered YAML strings. Rejected because HCL objects through `yamlencode` are deterministic and easier to compose than string templates.

### 2. Workflow-engine module owns route definitions

The CRD objects (3 Middlewares + 1 IngressRoute) move from `modules/workflow-engine/modules/routing/routing.tf` to a `traefik_extra_objects` output on `modules/workflow-engine/workflow-engine.tf`. The workflow-engine module already has access to `module.app.service_name`, `module.app.service_port`, `module.oauth2_proxy.service_name`, `module.oauth2_proxy.service_port`, and `var.network` — everything needed to construct the CRDs.

**Why workflow-engine owns routes:** The route definitions are intrinsic to the application — which paths need auth, which are public, which services handle which prefixes. Every environment deploys the same routes. Only the Traefik Helm config (NodePort vs LoadBalancer, ports) varies per environment.

**Alternative considered:** Root config constructs CRDs. Rejected because it would require exposing internal service names/ports from workflow-engine, leaking implementation details upward.

### 3. URL output moves to root config

Currently chains: routing → workflow_engine → root. After routing leaves workflow_engine, the URL is computed directly in the root config from `var.domain` and `var.https_port`. No module needed — it's a simple string computation.

### 4. Temporary `moved` block for state migration

A `moved` block maps `module.workflow_engine.module.routing.helm_release.traefik` → `module.routing.helm_release.traefik`. This ensures `tofu plan` shows no destroy/create for the Helm release. Removed after validation since there is no existing state to migrate.

### 5. `required_providers` preserved on new routing module

The new `modules/routing/routing.tf` declares `hashicorp/helm ~> 3.1` in its `required_providers` block, identical to the old routing submodule. This ensures correct provider inheritance through the `moved` block and prevents implicit provider resolution differences.

## Risks / Trade-offs

**yamlencode determinism** — The extraObjects must produce byte-identical YAML before and after refactoring, or the Helm release will show a diff. Mitigated by: using `type = any` (no coercion), preserving identical HCL object structure, and `yamlencode` sorting map keys deterministically.

**Helm `set` list ordering** — The Helm provider treats `set` as an ordered list. The `traefik_helm_sets` variable must preserve the exact 4-item order from the current hardcoded list. Mitigated by: copying the order verbatim into the root config.

**`tofu init` required after rename** — Developers pulling the rename need to run `tofu init` in the new `infrastructure/local/` directory. The `postinstall` script handles this automatically via `pnpm install`.
