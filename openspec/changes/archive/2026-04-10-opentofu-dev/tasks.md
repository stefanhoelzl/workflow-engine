## 1. Pulumi Teardown

- [x] 1.1 Extract OAuth2 secrets from Pulumi config (`pulumi config --show-secrets`) and save to `infrastructure/dev/dev.secrets.auto.tfvars`
- [x] 1.2 Run `pulumi destroy` to tear down existing Docker containers
- [x] 1.3 Run `pulumi stack rm dev` to remove the Pulumi stack
- [x] 1.4 Delete Pulumi files: `index.ts`, `package.json`, `tsconfig.json`, `Pulumi.yaml`, `Pulumi.dev.yaml`, `Caddyfile`
- [x] 1.5 Remove `infrastructure` from `pnpm-workspace.yaml` and clean up Pulumi dependencies from lockfile
- [x] 1.6 Remove `infra:update` and `infra:destroy` npm scripts from root `package.json`

## 2. Project Structure

- [x] 2.1 Create `infrastructure/.gitignore` (ignore `*.secrets.auto.tfvars`, `.terraform/`, `*.tfstate`, `*.tfstate.backup`)
- [x] 2.2 Create directory structure: `infrastructure/modules/kubernetes/kind/`, `infrastructure/modules/image/local/`, `infrastructure/modules/image/registry/`, `infrastructure/modules/s3/s2/`, `infrastructure/modules/workflow-engine/modules/app/`, `infrastructure/modules/workflow-engine/modules/oauth2-proxy/`, `infrastructure/modules/workflow-engine/modules/routing/`, `infrastructure/dev/`

## 3. Infrastructure Modules — Kubernetes

- [x] 3.1 Create `modules/kubernetes/kind/main.tf` — `kind_cluster` resource with `extraPortMappings` (https_port → 443), `kind_load` resource for image loading
- [x] 3.2 Create `modules/kubernetes/kind/variables.tf` — `cluster_name`, `https_port`, `image_name`
- [x] 3.3 Create `modules/kubernetes/kind/outputs.tf` — `cluster_name`, `host`, `cluster_ca_certificate`, `client_certificate`, `client_key`

## 4. Infrastructure Modules — Image

- [x] 4.1 Create `modules/image/local/main.tf` — `terraform_data` with `local-exec` provisioner for idempotent `podman build` (skip if exists, warn if >1 day)
- [x] 4.2 Create `modules/image/local/variables.tf` — `image_name`, `dockerfile_path`, `context_dir`
- [x] 4.3 Create `modules/image/local/outputs.tf` — `image_name`
- [x] 4.4 Create `modules/image/registry/main.tf` — output-only module constructing `registry/repository:tag`
- [x] 4.5 Create `modules/image/registry/variables.tf` — `registry`, `repository`, `tag`
- [x] 4.6 Create `modules/image/registry/outputs.tf` — `image_name`

## 5. Infrastructure Modules — S3

- [x] 5.1 Create `modules/s3/s2/main.tf` — `kubernetes_deployment_v1` (mojatter/s2-server:0.4.1, memfs, env vars), `kubernetes_service_v1` (port 9000), liveness probe (`GET /healthz`)
- [x] 5.2 Create `modules/s3/s2/variables.tf` — `access_key`, `secret_key`, `buckets`
- [x] 5.3 Create `modules/s3/s2/outputs.tf` — `endpoint`, `bucket`, `access_key`, `secret_key`, `region`

## 6. Application Module — App Sub-module

- [x] 6.1 Create `modules/workflow-engine/modules/app/main.tf` — `kubernetes_secret_v1` (S3 creds), `kubernetes_deployment_v1` (app image, S3 env from secret, liveness + readiness probes on `/healthz:8080`), `kubernetes_service_v1` (port 8080)
- [x] 6.2 Create `modules/workflow-engine/modules/app/variables.tf` — `image`, `s3_endpoint`, `s3_bucket`, `s3_access_key`, `s3_secret_key`, `s3_region`
- [x] 6.3 Create `modules/workflow-engine/modules/app/outputs.tf` — `service_name`, `service_port`

## 7. Application Module — OAuth2-proxy Sub-module

- [x] 7.1 Create `modules/workflow-engine/modules/oauth2-proxy/main.tf` — `random_password` (32 bytes), `kubernetes_secret_v1` (client_id, client_secret, cookie_secret), `kubernetes_deployment_v1` (oauth2-proxy:v7.15.1, env vars, liveness probe on `/ping:4180`), `kubernetes_service_v1` (port 4180)
- [x] 7.2 Create `modules/workflow-engine/modules/oauth2-proxy/variables.tf` — `client_id`, `client_secret`, `github_user`, `redirect_url`
- [x] 7.3 Create `modules/workflow-engine/modules/oauth2-proxy/outputs.tf` — `service_name`, `service_port`
- [x] 7.4 Create `modules/workflow-engine/modules/oauth2-proxy/versions.tf` — declare `hashicorp/random ~> 3.8`

## 8. Application Module — Routing Sub-module

- [x] 8.1 Create `modules/workflow-engine/modules/routing/main.tf` — `helm_release` (traefik/traefik chart 39.0.7), `kubernetes_manifest` (ForwardAuth Middleware CRD), `kubernetes_manifest` (IngressRoute CRD with 4 route rules + TLS)
- [x] 8.2 Create `modules/workflow-engine/modules/routing/variables.tf` — `domain`, `https_port`, `app_service`, `app_port`, `oauth2_service`, `oauth2_port`, `cert_resolver`
- [x] 8.3 Create `modules/workflow-engine/modules/routing/outputs.tf` — `url` (omit port when 443)
- [x] 8.4 Create `modules/workflow-engine/modules/routing/versions.tf` — declare `hashicorp/helm ~> 3.1`, `hashicorp/kubernetes ~> 3.0`

## 9. Application Module — Parent

- [x] 9.1 Create `modules/workflow-engine/main.tf` — instantiate app, oauth2-proxy, routing sub-modules with internal wiring (service names/ports from app and oauth2-proxy feed into routing)
- [x] 9.2 Create `modules/workflow-engine/variables.tf` — `image`, `s3_endpoint`, `s3_bucket`, `s3_access_key`, `s3_secret_key`, `s3_region`, `oauth2_client_id`, `oauth2_client_secret`, `oauth2_github_user`, `oauth2_redirect_url`, `domain`, `https_port`, `cert_resolver`
- [x] 9.3 Create `modules/workflow-engine/outputs.tf` — `url` (from routing)

## 10. Dev Root Configuration

- [x] 10.1 Create `dev/versions.tf` — `required_version >= 1.11`, all required_providers with version constraints, `backend "local" {}`
- [x] 10.2 Create `dev/variables.tf` — all input variables (domain, https_port, oauth2_*, s2_*) with sensitive markers
- [x] 10.3 Create `dev/main.tf` — module wiring (image/local → kubernetes/kind → providers, s3/s2, workflow-engine)
- [x] 10.4 Create `dev/outputs.tf` — `url` from workflow-engine module
- [x] 10.5 Create `dev/terraform.tfvars` — non-secret defaults (domain=localhost, https_port=8443, oauth2_github_user, s2 creds)

## 11. Verify

- [x] 11.1 Run `tofu init` in `infrastructure/dev/` — verify providers install and lock file is generated
- [x] 11.2 Run `tofu apply` in `infrastructure/dev/` — verify kind cluster, image build, all K8s resources created
- [x] 11.3 Verify app is accessible at `https://localhost:8443/dashboard/`
- [x] 11.4 Verify OAuth2 flow works (sign in via GitHub, redirect back)
- [x] 11.5 Verify S3 storage works (app writes/reads events via S2)
- [x] 11.6 Commit `.terraform.lock.hcl` to git
- [x] 11.7 Run `pnpm lint`, `pnpm check`, and `pnpm test` to verify nothing is broken
- [x] 11.8 Update `CLAUDE.md` with OpenTofu dev stack instructions (how to init, apply, destroy, prerequisites)
- [x] 11.9 Update `openspec/project.md` — add Infrastructure section covering OpenTofu, kind, Traefik, deployment architecture
- [x] 11.10 Update `openspec/config.yaml` — add infrastructure context (OpenTofu, HCL, Kubernetes, Helm) and infrastructure-specific rules
