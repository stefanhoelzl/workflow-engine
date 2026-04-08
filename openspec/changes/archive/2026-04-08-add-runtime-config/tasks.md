## 1. Dependencies

- [x] 1.1 Add `zod` as a dependency to `packages/runtime/package.json` and run `pnpm install`

## 2. Config Module

- [x] 2.1 Create `packages/runtime/src/config.ts` with Zod schema (`LOG_LEVEL` enum with default `"info"`, `PORT` coerced number with default `8080`) and `createConfig(env)` factory function
- [x] 2.2 Add tests for `createConfig`: valid values, defaults, partial env, invalid log level, non-numeric port

## 3. Integration

- [x] 3.1 Update `main.ts` to call `createConfig(process.env)` and use the returned config object instead of direct `process.env` access for `LOG_LEVEL` and `PORT`
- [x] 3.2 Remove biome-ignore comments for `noProcessEnv` on the replaced lines
