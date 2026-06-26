FROM node:24-slim AS build

WORKDIR /app

# Native-binding runtime lib for the build stage. The SQL engine (libSQL,
# `@libsql/client`) and quickjs-wasi ship prebuilt Rust/native bindings;
# libatomic1 covers atomic intrinsics some prebuilts reference. Harmless if
# unused. The distroless runtime loads the bindings without extra apt packages.
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
RUN pnpm fetch

COPY . .
RUN pnpm install --offline --frozen-lockfile

RUN pnpm build
RUN pnpm deploy --prod --shamefully-hoist --filter @workflow-engine/runtime /app/deploy
RUN cp -r packages/runtime/dist/* /app/deploy/

FROM gcr.io/distroless/nodejs24-debian13

WORKDIR /app

COPY --from=build /app/deploy .

ARG GIT_SHA=dev
ENV APP_GIT_SHA=$GIT_SHA

EXPOSE 8080

USER 65532

CMD ["main.js"]
