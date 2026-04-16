FROM node:24-slim AS build

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/runtime/package.json packages/runtime/
COPY packages/sandbox/package.json packages/sandbox/
COPY packages/sdk/package.json packages/sdk/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/runtime/tsconfig.json packages/runtime/vite.config.ts packages/runtime/
COPY packages/runtime/src/ packages/runtime/src/
COPY packages/sandbox/tsconfig.json packages/sandbox/
COPY packages/sandbox/src/ packages/sandbox/src/
COPY packages/sdk/tsconfig.json packages/sdk/
COPY packages/sdk/src/ packages/sdk/src/
RUN pnpm --filter @workflow-engine/runtime exec vite build
RUN pnpm deploy --prod --shamefully-hoist --filter @workflow-engine/runtime /app/deploy
RUN cp -r packages/runtime/dist/* /app/deploy/

FROM gcr.io/distroless/nodejs24-debian13

WORKDIR /app

COPY --from=build /app/deploy .

EXPOSE 8080

USER 65532

CMD ["main.js"]
