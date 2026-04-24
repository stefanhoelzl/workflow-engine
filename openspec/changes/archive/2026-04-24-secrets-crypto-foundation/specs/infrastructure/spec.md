## ADDED Requirements

### Requirement: Persistence project generates secrets keypair list

`infrastructure/envs/persistence/` SHALL generate a list of X25519 keypairs via `random_bytes` resources, one per entry in a `var.secret_key_ids` list variable. The primary (active sealing) key SHALL be the first entry in the list.

```hcl
variable "secret_key_ids" {
  type    = list(string)
  default = ["k1"]
}

resource "random_bytes" "secret_key" {
  for_each = toset(var.secret_key_ids)
  length   = 32
}

output "secrets_private_keys" {
  sensitive = true
  value = join(",", [
    for id in var.secret_key_ids : "${id}:${random_bytes.secret_key[id].base64}"
  ])
}
```

The output `secrets_private_keys` SHALL be a sensitive CSV string of `keyId:base64(sk)` entries in the declared order. Rotation SHALL be performed by prepending a new id to `var.secret_key_ids` and running `tofu apply`.

#### Scenario: Default state generates one key

- **GIVEN** `var.secret_key_ids` defaults to `["k1"]`
- **WHEN** `tofu apply` runs in `envs/persistence/`
- **THEN** the state SHALL contain one `random_bytes.secret_key["k1"]` resource with 32 bytes
- **AND** the `secrets_private_keys` output SHALL be `"k1:<base64>"`

#### Scenario: Adding a second id preserves the first

- **GIVEN** existing state with `var.secret_key_ids = ["k1"]`
- **WHEN** `var.secret_key_ids` is updated to `["k2", "k1"]` and `tofu apply` runs
- **THEN** `random_bytes.secret_key["k1"]` SHALL remain unchanged
- **AND** a new `random_bytes.secret_key["k2"]` resource SHALL be created
- **AND** `secrets_private_keys` SHALL be `"k2:<b64_new>,k1:<b64_existing>"`

#### Scenario: Output is marked sensitive

- **GIVEN** the persistence output
- **WHEN** rendered in `tofu plan` or `tofu apply`
- **THEN** the value SHALL be displayed as `(sensitive value)` and not in plaintext

### Requirement: Prod project reads persistence output and creates K8s Secret

`infrastructure/envs/prod/` SHALL read `secrets_private_keys` via a `terraform_remote_state` data source on the persistence state and create a `kubernetes_secret_v1` resource named `app-secrets-key` in the prod namespace with a single data key `SECRETS_PRIVATE_KEYS` set to the persistence output.

```hcl
data "terraform_remote_state" "persistence" { ... }

resource "kubernetes_secret_v1" "secrets_key" {
  metadata { name = "app-secrets-key"; namespace = "prod" }
  data = {
    SECRETS_PRIVATE_KEYS =
      data.terraform_remote_state.persistence.outputs.secrets_private_keys
  }
}
```

#### Scenario: Prod apply creates the secret

- **GIVEN** persistence output has been produced and prod project has the remote_state wiring
- **WHEN** `tofu apply` runs in `envs/prod/`
- **THEN** K8s SHALL have a Secret named `app-secrets-key` in the prod namespace
- **AND** the secret SHALL have one data key `SECRETS_PRIVATE_KEYS` matching the persistence output

### Requirement: Staging and local projects generate own keypairs

`infrastructure/envs/staging/` and `infrastructure/envs/local/` SHALL each generate their own keypair list via local `random_bytes` resources (not via persistence remote state), and create their own `app-secrets-key` K8s Secret in their respective namespaces. The variable and resource structure SHALL mirror the persistence project's shape.

Losing staging or local state SHALL NOT require cross-environment coordination; each environment's keypair is independent.

#### Scenario: Staging apply generates independent keypair

- **GIVEN** `envs/staging/` has its own `var.secret_key_ids`
- **WHEN** `tofu apply` runs
- **THEN** the staging keypair SHALL be generated from local state, not from persistence remote_state
- **AND** a K8s Secret `app-secrets-key` SHALL be created in the staging namespace

#### Scenario: Local apply generates independent keypair

- **GIVEN** `envs/local/` has its own `var.secret_key_ids`
- **WHEN** `tofu apply` runs against the kind cluster
- **THEN** a K8s Secret `app-secrets-key` SHALL be created in the local namespace with a fresh keypair CSV

### Requirement: App pod env_from references app-secrets-key

`infrastructure/modules/app-instance/workloads.tf` SHALL add one `env_from.secret_ref { name = "app-secrets-key" }` block to the app container spec. The block SHALL inject the `SECRETS_PRIVATE_KEYS` key from the Secret into the container's env vars. This block SHALL be in addition to the existing `env_from` blocks for `app-s3-credentials` and `app-github-oauth`.

#### Scenario: App pod has SECRETS_PRIVATE_KEYS env var

- **GIVEN** the app deployment is applied with the env_from block
- **WHEN** a pod starts
- **THEN** `printenv SECRETS_PRIVATE_KEYS` inside the pod SHALL yield the non-empty CSV from the Secret
- **AND** no other new env vars SHALL be added by this change
