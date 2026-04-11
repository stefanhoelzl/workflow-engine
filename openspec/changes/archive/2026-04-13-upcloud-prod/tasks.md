## 1. Shared module changes

- [x] 1.1 Add optional `tls` variable to `modules/workflow-engine/workflow-engine.tf` (type `object({ certResolver = string })`, default `null`). Conditionally include `tls` block in IngressRoute within `traefik_extra_objects` output.
- [x] 1.2 Add `wait` variable to `modules/routing/routing.tf` (type `bool`, default `false`). Pass it to `helm_release.traefik.wait`.
- [x] 1.3 Verify local infrastructure still works: `cd infrastructure/local && tofu plan` should show no changes (or only the new variable defaults).

## 2. UpCloud Kubernetes module

- [x] 2.1 Create `modules/kubernetes/upcloud/upcloud.tf` with `upcloud_network`, `upcloud_kubernetes_cluster`, and `upcloud_kubernetes_node_group` resources. Variables: `cluster_name`, `zone`, `kubernetes_version`, `node_plan`, `node_count` (default `1`).
- [x] 2.2 Add `ephemeral "upcloud_kubernetes_cluster"` resource and output `host`, `cluster_ca_certificate`, `client_certificate`, `client_key` with `ephemeral = true`.

## 3. UpCloud Object Storage module

- [x] 3.1 Create `modules/s3/upcloud/upcloud.tf` with `upcloud_managed_object_storage_bucket`, `upcloud_managed_object_storage_user`, `upcloud_managed_object_storage_custom_policy` (scoped IAM policy), `upcloud_managed_object_storage_user_policy`, and `upcloud_managed_object_storage_user_access_key`. Variables: `service_uuid`, `endpoint`, `bucket_name`.
- [x] 3.2 Output S3 contract: `endpoint` (passthrough), `bucket`, `access_key`, `secret_key` (sensitive), `region` (`"us-east-1"`).

## 4. Persistence project

- [x] 4.1 Create `infrastructure/upcloud/persistence/persistence.tf` with S3 backend (key `persistence`), `upcloud` provider, `upcloud_managed_object_storage` resource, and `module "s3"` referencing `modules/s3/upcloud/`.
- [x] 4.2 Output the S3 contract fields (endpoint, bucket, access_key, secret_key, region) from the module.
- [x] 4.3 Create `infrastructure/upcloud/persistence/terraform.tfvars` with `region` default.

## 5. Production composition root

- [x] 5.1 Create `infrastructure/upcloud/upcloud.tf` with S3 backend (key `upcloud`), providers (`upcloud`, `kubernetes`, `helm`, `random`, `restapi`), and all variables (domain, zone, kubernetes_version, node_plan, image_tag, letsencrypt_staging, acme_email, oauth2_*, dynu_api_key).
- [x] 5.2 Add `terraform_remote_state` data source reading persistence project state (S3 backend, key `persistence`).
- [x] 5.3 Wire `module "cluster"` (kubernetes/upcloud), configure kubernetes + helm providers from ephemeral outputs.
- [x] 5.4 Wire `module "workflow_engine"` with image from ghcr.io, S3 from remote state, OAuth2 from variables, network with `https_port = 443`, and `tls = { certResolver = "letsencrypt" }`.
- [x] 5.5 Wire `module "routing"` with `wait = true` and `traefik_helm_sets` for LoadBalancer, TLS-ALPN-01, PVC, ACME email, and staging/prod caServer.
- [x] 5.6 Add `kubernetes_service_v1` data source (depends_on routing) to read LB IP.
- [x] 5.7 Add `restapi` provider config for Dynu API, `restapi_object` data source to look up domain by name, and `restapi_object` resource for A record pointing at LB IP.
- [x] 5.8 Add `url` output and `prod.secrets.auto.tfvars.example`.
- [x] 5.9 Create `infrastructure/upcloud/terraform.tfvars` with non-secret defaults (domain, zone).

## 6. CI and documentation

- [x] 6.1 Update `.github/workflows/ci.yml` to run `tofu init && tofu validate` for `infrastructure/upcloud/` and `infrastructure/upcloud/persistence/`.
- [x] 6.2 Update `package.json` validate script to include all three OpenTofu projects.
- [x] 6.3 Update CLAUDE.md with production deployment section (prerequisites, env vars, deployment procedure).
- [x] 6.4 Run `pnpm validate` to confirm everything passes.
