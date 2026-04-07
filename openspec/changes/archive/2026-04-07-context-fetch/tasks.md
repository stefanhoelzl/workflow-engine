## 1. Core Implementation

- [x] 1.1 Add `#fetch` private field and constructor parameter to `ActionContext` in `packages/runtime/src/context/index.ts`
- [x] 1.2 Add public `fetch(url: string | URL, init?: RequestInit): Promise<Response>` method to `ActionContext` that delegates to `#fetch`
- [x] 1.3 Add `#fetch` field to `ContextFactory` and accept it as second constructor parameter
- [x] 1.4 Thread `#fetch` from `ContextFactory` into `ActionContext` in the `action` factory method

## 2. Wiring

- [x] 2.1 Update `new ContextFactory(queue)` in `packages/runtime/src/main.ts` to pass `globalThis.fetch`

## 3. Tests

- [x] 3.1 Add unit tests for `ActionContext.fetch` delegation (GET, POST with options, error propagation) in `packages/runtime/src/context/context.test.ts`
- [x] 3.2 Update all `new ContextFactory(queue)` calls in `context.test.ts` to pass a mock fetch
- [x] 3.3 Update `stubContextFactory` in `packages/runtime/src/scheduler/scheduler.test.ts` to pass a mock fetch to `ActionContext`
- [x] 3.4 Update all `new ContextFactory(queue)` calls in `packages/runtime/src/actions/dispatch.test.ts` to pass a mock fetch
- [x] 3.5 Update `new ContextFactory(queue)` in `packages/runtime/src/integration.test.ts` to pass `globalThis.fetch`

## 4. Spec Update

- [x] 4.1 Apply delta spec to `openspec/specs/context/spec.md` — add fetch requirement and update ActionContext and ContextFactory requirements
