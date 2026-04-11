## Context

The local infrastructure was refactored in Phase 1: `infrastructure/dev/` renamed to `infrastructure/local/`, routing extracted into a parameterized top-level module, and route definitions moved into the workflow-engine module as `traefik_extra_objects` output. The module contracts (kubernetes, s3, routing, workflow-engine) are now environment-agnostic.

Production targets UpCloud (Frankfurt, de-fra1) with a budget of ~8 EUR/mo: free K8s control plane, ~3 EUR worker node (1 vCPU/1GB), free Managed LB Essentials, 5 EUR Object Storage (250GB min).

A single UpCloud Managed Object Storage instance hosts two buckets: `terraform-state` (created manually, admin user) and `workflow-engine` (created by OpenTofu, scoped app user). The state bucket serves as the S3 backend for all UpCloud OpenTofu projects.

## Goals / Non-Goals

**Goals:**
- Deploy workflow-engine to UpCloud Managed K8s with automated TLS and DNS
- Least-privilege S3 access: app user can only touch the app bucket
- Separate persistence lifecycle from cluster lifecycle (`tofu destroy` on cluster does not delete S3 data)
- CI validates all OpenTofu projects

**Non-Goals:**
- High availability (single worker node is acceptable)
- GitOps / automated deployment pipeline (manual `tofu apply` for now)
- Multi-environment (no staging — only local dev and prod)

## Decisions

### 1. Ephemeral credentials for K8s provider (UpCloud)

The `modules/kubernetes/upcloud/` module uses `ephemeral "upcloud_kubernetes_cluster"` to retrieve cluster credentials. These are never stored in OpenTofu state.

The kind module keeps its existing 4-field output (`host`, `cluster_ca_certificate`, `client_certificate`, `client_key`). The UpCloud ephemeral resource exposes the same 4 fields natively, so both modules fulfill the same contract without kubeconfig parsing.

**Alternative considered:** Data source (credentials in state). Rejected because the UpCloud provider already supports ephemeral resources, and the project requires OpenTofu >= 1.11 anyway.

### 2. Single Object Storage instance, scoped user policy

One instance (5 EUR/mo) hosts both buckets. The app user gets a custom IAM policy restricting access to the `workflow-engine` bucket only:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:HeadBucket", "s3:GetObject", "s3:PutObject",
               "s3:DeleteObject", "s3:ListBucket", "s3:GetBucketLocation"],
    "Resource": ["arn:aws:s3:::workflow-engine", "arn:aws:s3:::workflow-engine/*"]
  }]
}
```

The `objsto` provider is not needed — the `upcloud` provider handles instance, bucket, user, custom policy, user policy attachment, and access key creation.

**Alternative considered:** Two separate instances (full isolation). Rejected — doubles cost to 10 EUR/mo for no practical benefit given single-user project.

### 3. Persistence as separate OpenTofu project

`infrastructure/upcloud/persistence/` creates the Object Storage instance, app bucket, and scoped user. Its state lives in the manually-created state bucket (S3 backend, key `persistence`).

The main project (`infrastructure/upcloud/upcloud.tf`) reads persistence outputs via `terraform_remote_state` data source (same S3 backend, key `persistence`). Both projects share S3 backend credentials via environment variables.

**Alternative considered:** Single project with everything. Rejected — `tofu destroy` would delete persistent data.

### 4. TLS-ALPN-01 via Traefik + Let's Encrypt

Traefik's built-in ACME client handles TLS certificate provisioning on port 443 via the TLS-ALPN-01 challenge. No port 80 needed. Certificates persisted to a PVC (128Mi). Staging/production ACME server switchable via `var.letsencrypt_staging` (defaults to `true`).

The workflow-engine module gains an optional `tls` variable (`{ certResolver = "letsencrypt" }` or `null`). When set, the IngressRoute includes a `tls` block.

**Alternative considered:** HTTP-01 (needs port 80), DNS-01 (Dynu not natively supported by Traefik). TLS-ALPN-01 is the simplest — one port, built-in support.

### 5. Managed LB Essentials (free) for stable IP

Traefik's Service type is `LoadBalancer`. UpCloud's Cloud Controller Manager provisions a Managed LB Essentials instance (free tier) with a stable public IP. The routing module gains a `wait` variable (default `false`); prod sets `wait = true` so Helm blocks until the LB IP is assigned.

A `kubernetes_service_v1` data source (with `depends_on` on the routing module) reads the external IP after deployment.

**Alternative considered:** NodePort + worker node public IP. Rejected — IP changes on node replacement, no free stable alternative.

### 6. Dynu DNS via restapi provider

The Dynu domain (`workflow-engine.webredirect.org`) is assumed to already exist. A `restapi_object` data source queries `GET /v2/dns` with `search_key = "name"` to look up the domain ID. A `restapi_object` resource creates the A record pointing at the LB IP.

**Alternative considered:** Dedicated Dynu provider (doesn't exist), `local-exec` curl (not declarative). The `Mastercard/restapi` provider is the most OpenTofu-native generic REST solution.

### 7. No image module for prod

The `image/local` module builds images with Podman. Prod doesn't build — it pulls from `ghcr.io`. Instead of a passthrough `image/registry` module, the composition root constructs the image reference directly: `"ghcr.io/stefanhoelzl/workflow-engine:${var.image_tag}"`.

**Alternative considered:** `image/registry` module. Rejected — a module that just concatenates strings adds no value.

## Risks / Trade-offs

**[Single worker node]** No HA. Node failure = downtime. Mitigation: acceptable for a personal project. Scale up later if needed.

**[Helm wait timeout]** `wait = true` blocks until LB IP is assigned. If CCM is slow, `tofu apply` could timeout. Mitigation: Helm default timeout is 5 minutes, which should be sufficient. Can be increased via `timeout` on the `helm_release`.

**[Ephemeral resource support]** The UpCloud provider's ephemeral resource is relatively new. If it breaks in a provider update, fall back to data source. Mitigation: provider version pinned to `~> 5.0`.

**[Let's Encrypt rate limits]** Production ACME server has rate limits (50 certs/week per domain). Mitigation: default to staging, switch to production only when ready.

**[State bucket manual setup]** The state bucket and admin user are created manually — not tracked in IaC. Mitigation: documented one-time procedure. Can be re-imported if needed.

**[restapi provider fragility]** Dynu API changes could break the DNS automation. Mitigation: DNS is a one-time setup; if it breaks, set the A record manually and remove the restapi resources.
