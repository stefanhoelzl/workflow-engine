## MODIFIED Requirements

### Requirement: Traefik workload network allow-rules

The traefik module SHALL create the Traefik NetworkPolicy via the `modules/netpol/` factory. The policy SHALL use cross-namespace selectors for egress to app backends in workload namespaces.

The module SHALL accept a `workload_namespaces` variable (list of string) to construct namespace-selector-based egress rules. Egress to ACME solver pods SHALL use a namespace-agnostic selector (`namespace_selector = {}`) since solver pods appear transiently in any namespace with a Certificate resource.

The policy SHALL NOT include an egress rule for `oauth2-proxy` pods because no such pods exist after the `replace-oauth2-proxy` change; any such rule SHALL be removed.

#### Scenario: Traefik reaches app backend across namespaces

- **WHEN** Traefik routes a request to the app's `:8080`
- **THEN** the egress rule with `namespaceSelector` for the app's namespace SHALL permit the connection

#### Scenario: Traefik reaches ACME solver pods in any namespace

- **WHEN** cert-manager creates a solver pod in namespace `prod` during cert issuance
- **THEN** the egress rule SHALL permit Traefik to reach the solver pod on `:8089`

#### Scenario: No egress rule targets oauth2-proxy pods

- **WHEN** the rendered Traefik NetworkPolicy is inspected
- **THEN** it SHALL NOT contain any egress rule targeting pods labelled `app.kubernetes.io/name = oauth2-proxy` on any port
