## MODIFIED Requirements

### Requirement: Capability removed

This capability SHALL NOT carry any standalone reverse-proxy requirements; it has been folded into `infrastructure`. The K8s-specific surface (Helm release, IngressRoute CRDs, cluster-level Service + LoadBalancer, ACME PVC, ConfigMap-mounted Caddyfile, per-env site templating in a separate cluster project) does not exist on the single-VPS shape. Reverse-proxy concerns (Caddy Quadlet with `Network=host`, tofu-rendered Caddyfile with one site block per VPS app env, ACME state on a host bind mount) MUST live in the `infrastructure` capability spec.

#### Scenario: Reverse-proxy requirements live in infrastructure

- **WHEN** an operator looks up Caddy / TLS / reverse-proxy requirements
- **THEN** the canonical source SHALL be `openspec/specs/infrastructure/spec.md` (the `Quadlet units for caddy and wfe-prod` requirement and adjacent requirements)
