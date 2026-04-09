## 1. Move and update Dockerfile

- [x] 1.1 Move `Dockerfile` to `infrastructure/Dockerfile`
- [x] 1.2 Add `COPY workflows/package.json workflows/` before `pnpm install`
- [x] 1.3 Add `COPY workflows/tsconfig.json workflows/vite.config.ts workflows/` and `COPY workflows/*.ts workflows/` before `pnpm build`
- [x] 1.4 Add `RUN cp -r workflows/dist /workflows` after `pnpm build`
- [x] 1.5 Add `COPY --from=build /workflows /workflows` to the production stage
- [x] 1.6 Add `ENV WORKFLOW_DIR=/workflows` to the production stage

## 2. Create Caddyfile

- [x] 2.1 Create `infrastructure/Caddyfile` with `localhost` site block, dashboard and webhook path matchers proxied to `app:8080`, and 404 catch-all

## 3. Create docker-compose.yml

- [x] 3.1 Create `infrastructure/docker-compose.yml` with `app` service (build from `../` context, `infrastructure/Dockerfile`, expose 8080, `PERSISTENCE_PATH=/events`, bind-mount `../.persistence:/events`, restart unless-stopped, json-file logging)
- [x] 3.2 Add `proxy` service (caddy:2 image, publish port 443, mount Caddyfile read-only, `caddy_data:/caddy` volume, `XDG_DATA_HOME=/caddy`, restart unless-stopped, json-file logging)
- [x] 3.3 Define `caddy_data` named volume

## 4. Update CI and scripts

- [x] 4.1 Update `.github/workflows/release.yml` to add `file: infrastructure/Dockerfile` to the build-push action
- [x] 4.2 Update root `package.json` start script to `docker compose -f infrastructure/docker-compose.yml up --build`

## 5. Verify

- [x] 5.1 Run `pnpm start` and verify both services start, Caddy serves HTTPS on localhost, dashboard and webhooks are reachable, and unmatched paths return 404
- [x] 5.2 Run `pnpm lint`, `pnpm check`, and `pnpm test` pass
