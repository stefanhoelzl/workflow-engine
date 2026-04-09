FROM node:24-slim AS build

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/runtime/package.json packages/runtime/
COPY packages/sdk/package.json packages/sdk/
COPY workflows/package.json workflows/
RUN pnpm install --frozen-lockfile

COPY vite.config.ts tsconfig.base.json ./
COPY packages/runtime/tsconfig.json packages/runtime/
COPY packages/sdk/tsconfig.json packages/sdk/
COPY packages/runtime/src/ packages/runtime/src/
COPY packages/sdk/src/ packages/sdk/src/
COPY workflows/tsconfig.json workflows/vite.config.ts workflows/
COPY workflows/*.ts workflows/
RUN pnpm build
RUN pnpm deploy --prod --filter @workflow-engine/runtime /app/deploy
RUN cp -r dist/* /app/deploy/
RUN cp -r workflows/dist /workflows

FROM gcr.io/distroless/nodejs24-debian13

WORKDIR /app

COPY --from=build /app/deploy .
COPY --from=build /workflows /workflows

ENV WORKFLOW_DIR=/workflows

EXPOSE 8080

USER nonroot

CMD ["main.js"]
