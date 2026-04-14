## Why

Today, Traefik's built-in ACME resolver stores Let's Encrypt certificates in `acme.json` on a 1Gi UpCloud block-storage PVC. The PVC costs money, pins Traefik to a single replica (RWO), and couples cert lifecycle to the ingress. cert-manager is the standard K8s way to handle certificates: certs become Secrets (no PVC), Certificate/Issuer CRDs provide observable lifecycle via `kubectl`, and the mechanism is ingress-agnostic.

## What Changes

- **BREAKING** — `infrastructure/modules/workflow-engine` `tls` variable shape changes from `{ certResolver }` to `{ secretName }`. The issuer is chosen by the `cert-manager` module's configuration, not by the workflow-engine module. Consumers (prod root, local root) must pass the new shape.
- **BREAKING** — prod root drops the `letsencrypt_staging` variable. Only a `letsencrypt-prod` ClusterIssuer ships.
- Add `infrastructure/modules/cert-manager/` — pure platform module that installs jetstack/cert-manager (pinned Helm chart version, `installCRDs=true`). Inputs: `acme_email`, `enable_acme`, `enable_selfsigned_ca`, `certificate_requests` (list of `{ name, namespace, secretName, dnsNames }`). Internally the module uses two Helm releases: the upstream cert-manager chart, and a tiny module-local chart (`extras-chart/`) that renders cert-manager custom resources (ClusterIssuers, self-signed CA Certificate, and per-request leaf Certificates) from a `values.extraObjects` list. The extras release `depends_on` the primary release so Helm resolves CR kinds *after* CRDs are registered — single-command `tofu apply` works on any state (fresh or existing), no bootstrap. From the caller's perspective the module is one block with one input shape; the two-release split is an implementation detail.
- The workflow-engine module no longer creates a Certificate resource. It instead emits a `cert_request` output (`{ name, namespace, secretName, dnsNames }`) that the root config wires into the cert-manager module's `certificate_requests` input.
- IngressRoute `tls` block becomes `{ secretName }` (reads from the cert-manager-managed Secret) instead of `{ certResolver }`.
- Remove the `traefik-certs` PVC and the Traefik `certificatesResolvers.letsencrypt.*` + `persistence.*` helm sets. On `tofu apply`, the PVC is removed from the cluster — but note: the `upcloud-block-storage-standard` StorageClass uses `reclaimPolicy: Retain`, so the bound PersistentVolume transitions to `Released` and the underlying UpCloud block-storage volume is NOT automatically deleted. One-time manual cleanup required: `kubectl delete pv <name>` and delete the orphan disk via the UpCloud console (or `upctl storage delete <uuid>`).
- ACME HTTP-01 challenge replaces TLS-ALPN-01. cert-manager's solver creates a standard k8s Ingress with `ingressClassName: traefik` that Traefik routes on the `web` entrypoint (port 80).
- Port 80 gains an explicit HTTP→HTTPS catch-all redirect (`PathPrefix(\`/\`)`, `priority=1`) so typing `http://...` no longer 404s. The existing `/error` loopback IngressRoute and cert-manager's solver Ingress remain higher-priority by rule specificity.
- Local kind environment also runs cert-manager with a self-signed CA chain (`selfsigned-bootstrap` → CA Certificate → `selfsigned-ca` ClusterIssuer → leaf cert). Local gains wiring parity with prod — the same `tls = { secretName }` variable shape is exercised end-to-end.
- No synchronous `wait-on-Ready` for the leaf Certificate — cert issuance happens asynchronously after `tofu apply` returns. Trade-off: single-command apply on any state; brief window (seconds for self-signed, 30-90s for ACME) on first apply where HTTPS is not yet served. Operators who need fast-fail can run `kubectl wait --for=condition=Ready certificate/...` after apply; documented in CLAUDE.md.

## Capabilities

### New Capabilities

None. This change extends the existing `infrastructure` capability rather than introducing a new one. Cert-manager is an infrastructure module sitting alongside `kubernetes`, `image`, `s3`, and `routing` — same pattern, same spec.

### Modified Capabilities

- `infrastructure`: workflow-engine module `tls` variable shape, IngressRoute TLS reference, Traefik helm sets (drop ACME resolver + persistence), Traefik cert PVC removal, prod composition root variables, new cert-manager module requirement, new ClusterIssuer requirements (ACME + self-signed CA) emitted via Helm extraObjects, cert-manager module owns leaf Certificate emission via `certificate_requests` input, port 80 HTTP→HTTPS redirect requirement, local kind TLS via self-signed CA chain.

## Impact

- `infrastructure/modules/workflow-engine/workflow-engine.tf` — variable shape change (shrink), new `cert_request` output, IngressRoute TLS ref change, no more kubernetes_manifest for Certificate.
- `infrastructure/modules/cert-manager/` — new module (two internal helm_releases: upstream cert-manager chart + local `extras-chart/` for CR rendering).
- `infrastructure/upcloud/upcloud.tf` — wire in cert-manager module with `certificate_requests = compact([module.workflow_engine.cert_request])`, drop `traefik-certs` PVC + `letsencrypt_staging` var, drop Traefik ACME/persistence helm sets.
- `infrastructure/local/local.tf` — wire in cert-manager module with `enable_selfsigned_ca=true`, pass `tls = { secretName = ... }` to workflow-engine module, same `certificate_requests` wiring.
- `CLAUDE.md` — remove the two-stage bootstrap section (no longer needed); add optional `kubectl wait` recipe for fast-fail on cert-issuance errors; update stack descriptions to mention cert-manager.
- `SECURITY.md §5` — R-I5 resolved; add cert-manager cluster RBAC residual risk; add cert-manager-managed TLS mitigation; add port 80 + cert-manager egress to entry points.
- No runtime code changes. No sandbox, event pipeline, or SDK impact.
- External dependency added: `jetstack/cert-manager` Helm chart (pinned version).
- First prod `tofu apply` triggers a brief TLS-handshake failure window (30-90s) while ACME issues asynchronously after apply exits.
