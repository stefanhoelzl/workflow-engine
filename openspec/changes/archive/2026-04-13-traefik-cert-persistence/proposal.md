## Why

Traefik's ACME certificate storage currently uses a PVC created by the Helm chart. The chart hardcodes `helm.sh/resource-policy: keep` on the PVC, which breaks clean `tofu destroy` — the PVC (and its underlying disk) survive. Manual `kubectl delete pvc` is required to avoid orphaned resources.

## What Changes

- Create the Traefik cert PVC as a `kubernetes_persistent_volume_claim_v1` resource in `infrastructure/upcloud/upcloud.tf` (managed by tofu, no keep-policy annotation)
- Configure the Traefik Helm chart to use `persistence.existingClaim` pointing at the tofu-managed PVC (so Helm does not create its own)
- Remove `persistence.size` and `persistence.storageClass` from `traefik_helm_sets` (these belong on the PVC resource now)
- Certs are NOT persisted across cluster rebuilds — treated as ephemeral, re-issued on cluster recreation. Default `letsencrypt_staging = true` avoids rate limits during testing.

## Capabilities

### New Capabilities

(none — all changes fall under the existing `infrastructure` capability)

### Modified Capabilities

- `infrastructure`: Main project manages Traefik's cert PVC declaratively; routing module uses `existingClaim` instead of chart-provisioned PVC

## Impact

- New resource: `kubernetes_persistent_volume_claim_v1` for Traefik ACME certs
- `tofu destroy` cleanly removes all K8s resources (no orphaned PVCs)
- Certs are regenerated on cluster rebuild (acceptable — LE issuance is fast, staging is unlimited)
- Storage cost unchanged (1 GB HDD disk, ~€0.085/month)
