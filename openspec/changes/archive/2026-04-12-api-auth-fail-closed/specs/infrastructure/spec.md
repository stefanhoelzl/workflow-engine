## MODIFIED Requirements

### Requirement: Non-secret variables in terraform.tfvars

The dev root SHALL load non-secret configuration from `terraform.tfvars` (committed): `domain`, `https_port`, `oauth2_github_users`, `s2_access_key`, `s2_secret_key`, `s2_bucket`. The `oauth2_github_users` variable SHALL be a string containing a comma-separated list of GitHub logins and SHALL feed both the oauth2-proxy allow-list and the app's `GITHUB_USER` environment variable so a single source of truth governs who may access the workflow engine.

#### Scenario: Default dev values

- **WHEN** `terraform.tfvars` is read
- **THEN** `domain` SHALL be `"localhost"`
- **AND** `https_port` SHALL be `8443`
- **AND** `oauth2_github_users` SHALL be a comma-separated list of allowed GitHub logins (default `"stefanhoelzl"`)

## ADDED Requirements

### Requirement: App module accepts github_users input

The `modules/workflow-engine/modules/app` module SHALL declare a `github_users` input variable (type `string`). The module SHALL inject the value as the `GITHUB_USER` environment variable on the app container using a plain `env { name = "GITHUB_USER" value = var.github_users }` block (i.e., not from a secret), so the allow-list is visible in pod specs and Kubernetes events for auditability.

#### Scenario: github_users threaded to pod env

- **WHEN** the `app` module is instantiated with `github_users = "alice,bob"`
- **THEN** the rendered `kubernetes_deployment_v1.app` SHALL contain a container `env` entry with `name = "GITHUB_USER"` and `value = "alice,bob"`

#### Scenario: github_users empty string

- **WHEN** the `app` module is instantiated with `github_users = ""`
- **THEN** the rendered deployment SHALL still include the `GITHUB_USER` env var with an empty string value
- **AND** the app SHALL resolve `githubAuth.mode` to `restricted` with a single empty-string user, which cannot match any GitHub login (effectively blocks all requests)

### Requirement: Workflow-engine module threads oauth2 allow-list to app

The `modules/workflow-engine` module SHALL pass `var.oauth2.github_users` into the `app` module as its `github_users` input. The app module SHALL NOT receive any other field from the `oauth2` variable.

#### Scenario: Allow-list propagation

- **WHEN** `tofu apply` runs with `oauth2.github_users = "alice,bob"`
- **THEN** the rendered oauth2-proxy deployment SHALL have `OAUTH2_PROXY_GITHUB_USERS=alice,bob`
- **AND** the rendered app deployment SHALL have `GITHUB_USER=alice,bob`
