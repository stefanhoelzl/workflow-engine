## 1. ActionContext

- [x] 1.1 Add `readonly env: Record<string, string | undefined>` property to `ActionContext` and accept it as a constructor parameter
- [x] 1.2 Add unit tests for `ctx.env` access (present key, missing key)

## 2. ContextFactory

- [x] 2.1 Add `env` as third constructor parameter to `ContextFactory`, stored as `#env`
- [x] 2.2 Thread `#env` into `ActionContext` in the `factory.action()` arrow property
- [x] 2.3 Add unit test: `factory.action(event)` returns context with injected env record

## 3. Wiring and sample migration

- [x] 3.1 Pass `process.env` as third argument to `ContextFactory` in `main.ts`
- [x] 3.2 Remove `requireEnv` helper and module-scope env var reads from `sample.ts`
- [x] 3.3 Update action handlers in `sample.ts` to read from `ctx.env.*`
- [x] 3.4 Update integration test for new `ContextFactory` constructor signature
