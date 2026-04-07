FROM node:24-slim AS build

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/runtime/package.json packages/runtime/
RUN pnpm install --frozen-lockfile

COPY vite.config.ts tsconfig.base.json ./
COPY packages/runtime/tsconfig.json packages/runtime/
COPY packages/runtime/src/ packages/runtime/src/
RUN pnpm build

FROM gcr.io/distroless/nodejs24-debian13

WORKDIR /app

COPY --from=build /app/dist/main.js .

EXPOSE 8080

USER nonroot

CMD ["main.js"]
