## ADDED Requirements

### Requirement: Capability removed

This capability SHALL NOT carry any standalone reverse-proxy requirements; it has been folded into `infrastructure`. The K8s-specific surface (Helm release, IngressRoute CRDs, cluster-level Service + LoadBalancer, ACME PVC, ConfigMap-mounted Caddyfile, per-env site templating in a separate cluster project) does not exist on the single-VPS shape. Reverse-proxy concerns (Caddy Quadlet with `Network=host`, tofu-rendered Caddyfile with one site block per env, ACME state on a host bind mount) MUST live in the `infrastructure` capability spec.

#### Scenario: Reverse-proxy requirements live in infrastructure

- **WHEN** an operator looks up Caddy / TLS / reverse-proxy requirements
- **THEN** the canonical source SHALL be `openspec/specs/infrastructure/spec.md` (the Quadlet-units-for-caddy-wfe-prod-wfe-staging requirement and adjacent requirements)

## REMOVED Requirements

### Requirement: Traefik Helm release

**Reason**: The `reverse-proxy` capability is folded into `infrastructure`. The K8s-specific surface (Helm release, IngressRoute CRDs) does not exist on the new shape. Caddy (not Traefik — Traefik was already replaced by Caddy in a prior change, but the spec name persisted) is now one of three rootless Podman + Quadlet units on the VPS.

**Migration**: Caddy's contract on the new shape (TLS termination, ACME via Let's Encrypt HTTP-01, per-env site blocks reverse-proxying to loopback ports) is described by the `infrastructure` capability requirements introduced in this change.

### Requirement: Traefik workload network allow-rules

**Reason**: NetworkPolicy is a K8s primitive that does not exist on the new shape. Traffic flow control is provided by the host firewall (default-deny inbound, allow 80/443/SSH-port) plus loopback-only app binds.

**Migration**: See `host-security-baseline` capability requirements "Host firewall default-deny" and "Workload binds restricted to loopback".

### Requirement: Traefik SHALL NOT enforce authentication

**Reason**: The "ingress is a pure TLS+routing layer with no authentication role" invariant is preserved verbatim — Caddy on the new shape does not enforce authentication either. The requirement is restated under the `infrastructure` capability in this change rather than living as a stand-alone capability.

**Migration**: The "Caddy SHALL NOT enforce authentication" requirement is added to the `infrastructure` capability spec in this change. The cross-references in `SECURITY.md §3` and `auth/spec.md` are updated to point at `infrastructure` instead of `reverse-proxy`.
