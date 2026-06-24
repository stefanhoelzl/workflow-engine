## MODIFIED Requirements

### Requirement: Dynu CNAMEs owned by tofu

The project SHALL manage two Dynu DNS records:

- `workflow-engine.webredirect.org` → VPS public IP (or its DNS name). **Unchanged by this change.**
- `staging.workflow-engine.webredirect.org` → the **Bunny CDN endpoint host** (a CNAME to the Magic Containers CDN endpoint's `*.b-cdn.net` hostname). This record is re-targeted from the VPS IP to Bunny to cut staging traffic over to Magic Containers.

The hostname itself is unchanged, so `BASE_URL` and the staging GitHub OAuth callback remain valid across the cutover. The VPS staging stack — `wfe-staging.container`, `/etc/wfe/staging.env`, the `/srv/wfe/staging` Block Storage volume and its mount, and the Caddy `staging.workflow-engine.webredirect.org` site block — SHALL all be retained, running, and unedited as a live warm fallback (still auto-pulling `:main`). Switching staging back to the VPS SHALL be a hand-edit of this single record's target back to the VPS IP followed by `tofu apply`; the project SHALL NOT introduce a `staging_backend` toggle variable.

Records SHALL be created via the existing dynu provider, parameterised by `var.dynu_api_key`. TTL SHALL be small enough (≤ 300 s) that DNS-level corrections during validation propagate quickly.

#### Scenario: Prod CNAME resolves to the VPS

- **GIVEN** tofu apply has completed and Dynu propagation has occurred
- **WHEN** `dig workflow-engine.webredirect.org` is run from an external resolver
- **THEN** it SHALL resolve to the Scaleway VPS public IP

#### Scenario: Staging hostname resolves to the Bunny CDN endpoint

- **GIVEN** tofu apply has completed and Dynu propagation has occurred
- **WHEN** `dig staging.workflow-engine.webredirect.org` is run from an external resolver
- **THEN** it SHALL resolve (via CNAME) to the Bunny Magic Containers CDN endpoint host
- **AND** the VPS staging Quadlet, env file, volume, mount, and Caddy site block SHALL still be present and running on the VPS

#### Scenario: Switching staging back to the VPS is a one-record edit

- **GIVEN** staging is served by Bunny and the VPS staging stack is still running on `:main`
- **WHEN** the operator re-targets the `staging.workflow-engine.webredirect.org` record back to the VPS IP and runs `tofu apply`
- **THEN** the plan SHALL show only that one DNS record changing
- **AND** no `staging_backend` variable SHALL be required to perform the switch
- **AND** Caddy SHALL re-issue the staging cert automatically once DNS points back at the VPS
