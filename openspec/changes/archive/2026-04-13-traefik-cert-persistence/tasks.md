## 1. Cleanup of stuck resources

- [x] 1.1 Remove the failed Helm release from main project state: `tofu -chdir=infrastructure/upcloud state rm module.routing.helm_release.traefik`
- [x] 1.2 Delete the stuck `traefik` PVC from the cluster via kubectl

## 2. Main project: tofu-managed PVC

- [x] 2.1 Add `kubernetes_persistent_volume_claim_v1 "traefik_certs"` to `infrastructure/upcloud/upcloud.tf` (name: `traefik-certs`, namespace: `default`, ReadWriteOnce, storage class `upcloud-block-storage-standard`, 1Gi, `wait_until_bound = false`)
- [x] 2.2 Update `module "routing"` `traefik_helm_sets`: remove `persistence.storageClass` and `persistence.size`, add `persistence.existingClaim` referencing the new PVC's name

## 3. Validation

- [x] 3.1 Run `pnpm validate` to confirm syntax and type correctness
- [x] 3.2 Run `tofu -chdir=infrastructure/upcloud plan` — should show PVC creation and Helm release creation (no unexpected changes)
- [x] 3.3 Run `tofu apply` — Helm release should succeed this time (pod runs, LB gets IP, DNS record created)
