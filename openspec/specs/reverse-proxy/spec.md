<!-- All requirements removed by change: opentofu-dev. This capability was replaced by infrastructure. -->

## Purpose

Traefik reverse-proxy Helm release and configuration for the cluster. Traefik is a pure TLS + routing gateway; it performs no authentication, authorization, or forward-auth gating — all auth responsibility belongs to the app (see `auth/spec.md` and `http-server/spec.md`). Error pages (404, 5xx) and the root redirect are served by the app in Hono, not by Traefik plugins.
## Requirements
### Requirement: Capability removed

This capability SHALL NOT carry any standalone reverse-proxy requirements; it has been folded into `infrastructure`. The K8s-specific surface (Helm release, IngressRoute CRDs, cluster-level Service + LoadBalancer, ACME PVC, ConfigMap-mounted Caddyfile, per-env site templating in a separate cluster project) does not exist on the single-VPS shape. Reverse-proxy concerns (Caddy Quadlet with `Network=host`, tofu-rendered Caddyfile with one site block per env, ACME state on a host bind mount) MUST live in the `infrastructure` capability spec.

#### Scenario: Reverse-proxy requirements live in infrastructure

- **WHEN** an operator looks up Caddy / TLS / reverse-proxy requirements
- **THEN** the canonical source SHALL be `openspec/specs/infrastructure/spec.md` (the Quadlet-units-for-caddy-wfe-prod-wfe-staging requirement and adjacent requirements)

