## REMOVED Requirements

### Requirement: Docker Compose file defines the local stack
**Reason**: Replaced by Pulumi IaC. All container orchestration is now managed by the Pulumi program in `infrastructure/index.ts`.
**Migration**: Use `pnpm deploy` (Pulumi) instead of `pnpm compose:up` (docker-compose).

### Requirement: app service builds from infrastructure/Dockerfile
**Reason**: Image building is now handled by `@pulumi/docker-build` in the Pulumi program.
**Migration**: Pulumi builds the image from the same Dockerfile automatically during `pulumi up`.

### Requirement: app service exposes port 8080 internally
**Reason**: Container networking is now managed by Pulumi's Docker provider.
**Migration**: Pulumi creates containers on a shared Docker network where they can reach each other by name.

### Requirement: app service configures persistence via bind-mount
**Reason**: Volume management is now handled by Pulumi `docker.Volume` resources.
**Migration**: Pulumi creates a named `persistence` volume mounted at `/events`.

### Requirement: proxy service uses stock Caddy image
**Reason**: Container image selection is now configured in the Pulumi program.
**Migration**: Pulumi pulls `caddy:2.11.2` and creates the container.

### Requirement: proxy service publishes port 443
**Reason**: Port mapping is now configured in the Pulumi program via stack config (`httpsPort`).
**Migration**: Pulumi maps the configured `httpsPort` to container port 443.

### Requirement: proxy service mounts Caddyfile and data volume
**Reason**: Volume mounts are now configured in the Pulumi program.
**Migration**: Pulumi mounts the Caddyfile and caddy-data volume.

### Requirement: Container restart and logging policies
**Reason**: Restart and logging policies are now configured per-container in the Pulumi program.
**Migration**: All containers retain `unless-stopped` restart and json-file logging (10MB, 3 files).

### Requirement: Caddy command includes --watch flag
**Reason**: Container commands are now configured in the Pulumi program.
**Migration**: Pulumi sets the same `caddy run --config ... --watch` command.

### Requirement: pnpm start runs docker-compose
**Reason**: Replaced by Pulumi-based scripts.
**Migration**: Use `pnpm deploy` instead of `pnpm start` / `pnpm compose:up`.
