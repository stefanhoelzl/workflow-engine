<!-- All requirements removed by change: opentofu-dev. This capability was replaced by infrastructure. -->

## Purpose

Traefik reverse-proxy Helm release and configuration for the cluster. Traefik is a pure TLS + routing gateway; it performs no authentication, authorization, or forward-auth gating — all auth responsibility belongs to the app (see `auth/spec.md` and `http-server/spec.md`). Error pages (404, 5xx) and the root redirect are served by the app in Hono, not by Traefik plugins.
## Requirements
### Requirement: Traefik Helm release

The traefik module (`modules/traefik/`, renamed from `modules/routing/`) SHALL create a `helm_release` installing the `traefik/traefik` chart version `39.0.7` in namespace `traefik` (moved from `default`). The release SHALL set explicit pod-level and container-level `securityContext` via Helm values, independent of chart defaults.

The Helm values SHALL include:
- `podSecurityContext`: `runAsNonRoot=true`, `runAsUser=65532`, `runAsGroup=65532`, `fsGroup=65532`, `fsGroupChangePolicy=OnRootMismatch`, `seccompProfile={type: RuntimeDefault}`
- `securityContext` (container-level): `allowPrivilegeEscalation=false`, `readOnlyRootFilesystem=true`, `capabilities={drop: [ALL]}`

The `extraObjects` value SHALL NOT include IngressRoutes or Middlewares (moved to per-instance routes-chart). The `traefik_extra_objects` variable and output are removed.

#### Scenario: Traefik installed in dedicated namespace

- **WHEN** `tofu apply` completes
- **THEN** the Traefik Helm release SHALL be deployed in namespace `traefik`
- **AND** the namespace SHALL be created if it does not exist

#### Scenario: Explicit security context overrides

- **WHEN** the Traefik pod is inspected
- **THEN** the pod SHALL have `runAsNonRoot=true` and `seccompProfile=RuntimeDefault`
- **AND** the main container SHALL have `allowPrivilegeEscalation=false` and `capabilities.drop=[ALL]`

#### Scenario: No IngressRoutes in extraObjects

- **WHEN** the Traefik Helm values are inspected
- **THEN** `extraObjects` SHALL be empty or absent
- **AND** IngressRoutes SHALL be delivered by per-instance routes-chart Helm releases

### Requirement: Traefik workload network allow-rules

The traefik module SHALL create the Traefik NetworkPolicy via the `modules/netpol/` factory. The policy SHALL use cross-namespace selectors for egress to app backends in workload namespaces.

The module SHALL accept a `workload_namespaces` variable (list of string) to construct namespace-selector-based egress rules. Egress to ACME solver pods SHALL use a namespace-agnostic selector (`namespace_selector = {}`) since solver pods appear transiently in any namespace with a Certificate resource.

#### Scenario: Traefik reaches app backend across namespaces

- **WHEN** Traefik routes a request to the app's `:8080`
- **THEN** the egress rule with `namespaceSelector` for the app's namespace SHALL permit the connection

#### Scenario: Traefik reaches ACME solver pods in any namespace

- **WHEN** cert-manager creates a solver pod in namespace `prod` during cert issuance
- **THEN** the egress rule SHALL permit Traefik to reach the solver pod on `:8089`

### Requirement: Traefik SHALL NOT enforce authentication

Traefik SHALL NOT implement any authentication, authorization, or forward-auth gating. All auth responsibility belongs to the app (see `auth/spec.md`). Traefik's sole duties are TLS termination and request routing to the app pod.

#### Scenario: No forward-auth middleware attached to routes

- **WHEN** the rendered Traefik IngressRoutes / Middlewares are inspected
- **THEN** no route SHALL have a `forwardAuth` middleware attached
- **AND** no `oauth2-proxy` backend SHALL exist in the cluster

