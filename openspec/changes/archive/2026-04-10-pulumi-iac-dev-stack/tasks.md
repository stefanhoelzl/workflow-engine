## 1. Workspace and project setup

- [x] 1.1 Add `infrastructure` to `pnpm-workspace.yaml`
- [x] 1.2 Create `infrastructure/package.json` with `@pulumi/pulumi`, `@pulumi/docker`, `@pulumi/docker-build` dependencies and `"type": "module"`
- [x] 1.3 Create `infrastructure/tsconfig.json` with `module: "nodenext"`, `moduleResolution: "nodenext"`
- [x] 1.4 Create `infrastructure/Pulumi.yaml` project definition (runtime: nodejs, name: workflow-engine)
- [x] 1.5 Run `pnpm install` to verify workspace resolution and dependency installation

## 2. Pulumi program

- [x] 2.1 Create `infrastructure/index.ts` — read stack config: `domain`, `httpsPort`, and four oauth2 secrets via `config.require` / `config.requireSecret`
- [x] 2.2 Add `docker_build.Image` resource: build from `../` context, `./Dockerfile`, tag `workflow-engine:dev`, export to local daemon (`docker: { tar: true }`), `push: false`
- [x] 2.3 Add `docker.Volume` resources: `caddy-data` and `persistence`
- [x] 2.4 Add `docker.Container` for app: image from build output, `PERSISTENCE_PATH=/events` env, persistence volume at `/events`, restart `unless-stopped`, json-file logging
- [x] 2.5 Add `docker.Container` for proxy: `caddy:2.11.2` image, `DOMAIN` and `XDG_DATA_HOME` env vars, port mapping `{httpsPort}:443`, Caddyfile bind mount (read-only), caddy-data volume, `--watch` command, restart + logging
- [x] 2.6 Add `docker.Container` for oauth2-proxy: `quay.io/oauth2-proxy/oauth2-proxy:v7.15.1` image, all `OAUTH2_PROXY_*` env vars from config/secrets, `REDIRECT_URL` derived from `domain` + `httpsPort`, restart + logging

## 3. Caddyfile modification

- [x] 3.1 Change `localhost` to `{$DOMAIN}` in `infrastructure/Caddyfile` (no fallback default)

## 4. Stack configuration

- [x] 4.1 Create `infrastructure/Pulumi.dev.yaml` with `domain: localhost` and `httpsPort: "8443"` defaults

## 5. Root package.json scripts

- [x] 5.1 Remove `compose`, `compose:up`, `compose:up:force`, `compose:down` scripts
- [x] 5.2 Add `deploy` (`pulumi -C infrastructure up --yes`) and `deploy:destroy` (`pulumi -C infrastructure destroy --yes`) scripts

## 6. Cleanup

- [x] 6.1 Delete `infrastructure/docker-compose.yml`

## 7. Verification

- [x] 7.1 Run `pulumi login` and `pulumi stack init dev` in `infrastructure/`
- [x] 7.2 Set oauth2 secrets via `pulumi config set --secret`
- [x] 7.3 Run `pnpm infra:update` and verify all three containers start and are reachable
- [x] 7.4 Run `pnpm infra:destroy` and verify all resources are cleaned up
- [x] 7.5 Run `pnpm lint`, `pnpm check`, and `pnpm test` to verify definition of done
