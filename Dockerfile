FROM node:24-slim AS build

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/runtime/package.json packages/runtime/
COPY packages/sdk/package.json packages/sdk/
RUN pnpm install --frozen-lockfile

COPY vite.config.ts tsconfig.base.json ./
COPY packages/runtime/tsconfig.json packages/runtime/
COPY packages/sdk/tsconfig.json packages/sdk/
COPY packages/runtime/src/ packages/runtime/src/
COPY packages/sdk/src/ packages/sdk/src/
RUN pnpm build
RUN pnpm deploy --prod --filter @workflow-engine/runtime /app/deploy
RUN cp dist/main.js /app/deploy/

FROM gcr.io/distroless/nodejs24-debian13

WORKDIR /app

COPY --from=build /app/deploy .

EXPOSE 8080

USER nonroot

CMD ["main.js"]
