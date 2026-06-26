## MODIFIED Requirements

### Requirement: CDN endpoint provides managed HTTPS for staging

The staging app SHALL expose a CDN-type endpoint (NOT Anycast) routing HTTP(S) to the container's 8080 port, providing automatic TLS. The hostname `staging.workflow-engine.stho.net` SHALL be attachable to this endpoint as a custom hostname (`bunnynet_pullzone_hostname`, `tls_enabled = true`, `force_ssl = true`) so `BASE_URL` and the GitHub OAuth callback resolve to the same public host.

Because Bunny issues the managed Let's Encrypt cert at the moment `tls_enabled` is true and only if the hostname's CNAME already resolves to Bunny, the staging DNS CNAME (see the `infrastructure` capability) SHALL be created and propagated BEFORE the apply that registers/validates this hostname — achieved by a two-step targeted apply (records first, full apply after `dig` confirms). The hostname SHALL be composed from the `base_domain` variable.

#### Scenario: CDN endpoint serves the staging hostname over HTTPS

- **GIVEN** the staging Bunny DNS CNAME for `staging.workflow-engine.stho.net` points at the Bunny CDN endpoint and Bunny has issued the cert
- **WHEN** an external client runs `curl -I https://staging.workflow-engine.stho.net/livez`
- **THEN** the response SHALL be served over a valid TLS chain
- **AND** the endpoint type SHALL be CDN, not Anycast
