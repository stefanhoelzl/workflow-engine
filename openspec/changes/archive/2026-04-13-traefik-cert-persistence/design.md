## Context

The Traefik Helm chart creates a PVC for ACME cert storage when `persistence.enabled = true`. The chart's PVC template hardcodes `helm.sh/resource-policy: keep`, which means:

- `helm uninstall` (or `tofu destroy` via `helm_release`) does NOT delete the PVC
- The PVC remains bound to its PV and disk, costing money indefinitely
- Manual `kubectl delete pvc` is required for cleanup

This breaks the project's "tofu destroy leaves no orphans" principle.

We explored two alternatives:
1. **Model B (this design)**: tofu-managed PVC with dynamic provisioning, `persistence.existingClaim` on Helm
2. **Model C**: pre-provisioned disk in persistence project, static PV via CSI, survives cluster rebuild

Model C was ruled out because:
- The UpCloud terraform provider has no `upcloud_permission` resource to grant the CSI sub-account access to a pre-created disk
- Would require `local-exec` to call the UpCloud API or `upctl` for permission grants
- The benefit (certs survive rebuild) is speculative — rebuilds are rare and Let's Encrypt re-issuance is fast

Model B is declarative, simple, and solves the actual problem.

## Goals / Non-Goals

**Goals:**
- `tofu destroy` cleans up the Traefik cert PVC and its disk without manual steps
- Cert storage is explicit in IaC (not implicit via Helm chart defaults)

**Non-Goals:**
- Preserving ACME certs across cluster rebuilds (rebuilds are rare; LE issuance is fast)
- Migrating existing certs (fresh deploy — no certs exist yet)

## Decisions

### 1. PVC in the main project, not persistence

The PVC is a K8s resource — it can only exist when the cluster exists. The cluster is the main project's responsibility. So the PVC goes there.

**Alternative considered:** Pre-provisioned disk in persistence + static PV in main (Model C). Rejected due to missing provider resource for CSI permissions.

### 2. `persistence.existingClaim` on Helm release

Traefik's chart supports pointing at an externally-managed PVC:

```hcl
{ name = "persistence.enabled",       value = "true" },
{ name = "persistence.existingClaim", value = kubernetes_persistent_volume_claim_v1.traefik_certs.metadata[0].name },
```

When `existingClaim` is set, the chart skips PVC creation entirely — no keep-policy annotation, no orphan on destroy.

### 3. Dynamic provisioning via `upcloud-block-storage-standard`

The PVC uses the HDD-tier storage class (`upcloud-block-storage-standard`) with 1 GB size (UpCloud minimum). Dynamic provisioning: CSI driver creates the PV and disk automatically when the PVC is applied.

**Cost:** ~€0.085/month for 1 GB HDD. Acceptable for rarely-written cert data.

### 4. Ordering via reference

`persistence.existingClaim` references `kubernetes_persistent_volume_claim_v1.traefik_certs.metadata[0].name`, creating an implicit dependency. The Helm release is applied after the PVC. No explicit `depends_on` needed.

### 5. `wait_until_bound = false`

Set on the PVC to avoid blocking `tofu apply` if the storage class has `WaitForFirstConsumer` binding. The PV will bind once Traefik's pod is scheduled (Helm's `wait = true` will block until pods are ready anyway).

## Risks / Trade-offs

**[Certs lost on cluster rebuild]** → Mitigation: `letsencrypt_staging = true` by default avoids production rate limits during rebuilds. Production rate limit (50 certs/week/domain) is generous for rare rebuilds.

**[Disk cost on failed deploys]** → If apply fails mid-way, PVC may exist without being cleaned up. Mitigation: `tofu destroy` or `tofu apply` (after fixing) cleans it up. No keep-policy.

## Migration Plan

Existing stuck `traefik` PVC (pending, no cert data) must be removed before the new PVC can be created:

1. Remove the failed Helm release from tofu state
2. Delete the old PVC from the cluster
3. Apply the new config — creates the tofu-managed PVC with name `traefik-certs`
4. Helm re-deploys Traefik using `existingClaim`
