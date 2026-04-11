## 1. Rename dev/ to local/

- [x] 1.1 `git mv infrastructure/dev infrastructure/local`
- [x] 1.2 `git mv infrastructure/local/dev.tf infrastructure/local/local.tf`
- [x] 1.3 ~`git mv infrastructure/local/dev.secrets.auto.tfvars.example infrastructure/local/local.secrets.auto.tfvars.example`~ (file does not exist, skipped)
- [x] 1.4 Update `package.json` scripts: replace `infrastructure/dev` with `infrastructure/local` in `validate`, `postinstall`, `infra:init`, `infra:up`, `infra:up:build`, `infra:destroy`
- [x] 1.5 Update `.github/workflows/ci.yml`: lock file path `infrastructure/dev/` → `infrastructure/local/`
- [x] 1.6 Update `CLAUDE.md`: secrets path `infrastructure/dev/dev.secrets.auto.tfvars.example` → `infrastructure/local/local.secrets.auto.tfvars.example`
- [x] 1.7 Update variable/output descriptions in `local.tf` from "dev" to "local"

## 2. Refactor routing module

- [x] 2.1 Create `infrastructure/modules/routing/routing.tf` — thin Traefik Helm wrapper with `traefik_extra_objects` (type = any) and `traefik_helm_sets` inputs, `required_providers` for helm ~> 3.1
- [x] 2.2 Add `traefik_extra_objects` output to `infrastructure/modules/workflow-engine/workflow-engine.tf` — construct the 4 CRD objects (3 Middlewares + 1 IngressRoute) from app/oauth2_proxy service outputs and `var.network`
- [x] 2.3 Remove `module "routing"` block and `output "url"` from `workflow-engine.tf`
- [x] 2.4 Delete `infrastructure/modules/workflow-engine/modules/routing/` directory
- [x] 2.5 Add top-level `module "routing"` to `infrastructure/local/local.tf` wiring `module.workflow_engine.traefik_extra_objects` and the 4 local helm sets
- [x] 2.6 Add `moved` block: `module.workflow_engine.module.routing.helm_release.traefik` → `module.routing.helm_release.traefik`
- [x] 2.7 Change `output "url"` in `local.tf` to compute directly from `var.domain` and `var.https_port`

## 3. Validation

- [x] 3.1 Run `tofu -chdir=infrastructure/local init` and `tofu -chdir=infrastructure/local validate`
- [x] 3.2 Remove `moved` block from `local.tf`
- [x] 3.3 Run `pnpm validate` (lint, format, typecheck, tests, tofu fmt, tofu validate)
