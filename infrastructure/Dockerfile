FROM node:24-slim AS build

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/runtime/package.json packages/runtime/
COPY packages/sandbox/package.json packages/sandbox/
COPY packages/sandbox-stdlib/package.json packages/sandbox-stdlib/
COPY packages/sdk/package.json packages/sdk/
# pnpm.patchedDependencies in pnpm-workspace.yaml references patches/ which
# must exist before `pnpm install --frozen-lockfile` or the install errors
# with "patch file not found".
COPY patches/ patches/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/core/tsconfig.json packages/core/
COPY packages/core/src/ packages/core/src/
COPY packages/runtime/tsconfig.json packages/runtime/vite.config.ts packages/runtime/
COPY packages/runtime/src/ packages/runtime/src/
COPY packages/sandbox/tsconfig.json packages/sandbox/vite.config.ts packages/sandbox/
COPY packages/sandbox/src/ packages/sandbox/src/
COPY packages/sandbox-stdlib/tsconfig.json packages/sandbox-stdlib/
COPY packages/sandbox-stdlib/src/ packages/sandbox-stdlib/src/
# SDK source is needed at build time: the runtime's vite bundle imports
# `../../sdk/src/sdk-support/index.ts?sandbox-plugin`, which the
# sandboxPlugins() vite transform resolves from disk.
COPY packages/sdk/tsconfig.json packages/sdk/
COPY packages/sdk/src/ packages/sdk/src/
# Build sandbox so its dist/src/worker.js is emitted — the runtime bundles
# sandbox's index.ts but the worker is loaded from disk at runtime via
# `new Worker(pathToFileURL(.../dist/src/worker.js))` (see
# resolveWorkerUrl() in packages/sandbox/src/index.ts).
RUN pnpm --filter @workflow-engine/sandbox exec vite build
RUN pnpm --filter @workflow-engine/runtime exec vite build
RUN pnpm deploy --prod --shamefully-hoist --filter @workflow-engine/runtime /app/deploy
RUN cp -r packages/runtime/dist/* /app/deploy/

FROM gcr.io/distroless/nodejs24-debian13

WORKDIR /app

COPY --from=build /app/deploy .

EXPOSE 8080

USER 65532

CMD ["main.js"]
