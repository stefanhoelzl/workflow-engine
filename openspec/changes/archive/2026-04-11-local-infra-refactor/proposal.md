## Why

We're preparing to add an UpCloud production environment. The current local dev infrastructure (`infrastructure/dev/`) has the routing module (Traefik Helm + IngressRoute CRDs) nested inside the workflow-engine module, making it environment-specific rather than reusable. The directory name `dev/` also doesn't distinguish between "local development" and a future "dev/staging" cloud environment. This refactoring makes modules reusable across environments so Phase 2 (UpCloud prod) can share them cleanly.

## What Changes

- Rename `infrastructure/dev/` to `infrastructure/local/` (including `dev.tf` to `local.tf` and `dev.secrets.auto.tfvars.example` to `local.secrets.auto.tfvars.example`)
- Update all references in `package.json`, `.github/workflows/ci.yml`, and `CLAUDE.md`
- Extract Traefik Helm deployment from `modules/workflow-engine/modules/routing/` into a new top-level `modules/routing/` module parameterized by `traefik_extra_objects` and `traefik_helm_sets`
- Move CRD definitions (Middlewares + IngressRoute) to a `traefik_extra_objects` output on the `workflow-engine` module
- Delete the old `modules/workflow-engine/modules/routing/` submodule
- Move `url` output computation from the routing/workflow-engine chain to the root config
- Zero infrastructure impact: validated by before/after `tofu plan` comparison

## Capabilities

### New Capabilities

None. This is a structural refactoring of existing infrastructure modules.

### Modified Capabilities

- `infrastructure`: Root config renamed from `dev/` to `local/`, routing module extracted to top-level, workflow-engine module no longer contains routing submodule and now outputs `traefik_extra_objects` instead. Provider wiring and variable contracts unchanged.

## Impact

- **Infrastructure modules**: `modules/routing/` created, `modules/workflow-engine/modules/routing/` deleted, `modules/workflow-engine/workflow-engine.tf` modified
- **Root config**: `infrastructure/dev/` renamed to `infrastructure/local/`, provider config unchanged
- **CI**: Lock file drift check path updated
- **Developer workflow**: `pnpm infra:*` scripts point to new directory, `tofu init` needed after pulling
- **No runtime/application code changes**
