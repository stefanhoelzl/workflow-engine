## 1. Add polyfill dependencies

- [x] 1.1 Add polyfill packages as devDependencies to `packages/vite-plugin/package.json`: `mock-xmlhttprequest`, `whatwg-fetch`, `url-polyfill`, `fast-text-encoding`, `abort-controller`, `blob-polyfill`, `abab`, `@ungap/structured-clone`, `web-streams-polyfill`
- [x] 1.2 Run `pnpm install` and verify lockfile updates cleanly

## 2. Create virtual module and inject into build

- [x] 2.1 Create the `SANDBOX_GLOBALS_SOURCE` constant in `packages/vite-plugin/src/index.ts` — the virtual module source that imports all polyfills, wires MockXhr.onSend to `__hostFetch`, and assigns globals to `globalThis`
- [x] 2.2 Add the `sandbox-globals` Vite plugin to `buildWorkflowModule()` — resolves `@workflow-engine/sandbox-globals` to virtual module ID `"\0sandbox-globals"`, injects `import "@workflow-engine/sandbox-globals"` via `transform` hook on the workflow entry
- [x] 2.3 Verify `pnpm build` produces `actions.js` containing polyfill setup code and handler exports

## 3. Add __hostFetch bridge and remove ctx.fetch

- [x] 3.1 Add `bridgeHostFetch(b, fetchFn)` function that registers `__hostFetch` as an async bridge on `b.vm.global` — accepts (method, url, headers, body), calls Node.js `globalThis.fetch`, returns `{status, statusText, headers, body}`
- [x] 3.2 Remove `bridgeFetch` from `bridge.ts` — delete the function and its call in `bridgeCtx`
- [x] 3.3 Remove `marshalResponse` and `marshalHeaders` from `bridge.ts`
- [x] 3.4 Call `bridgeHostFetch(b, globalThis.fetch)` in sandbox `spawn()` or `setupGlobals()`
- [x] 3.5 Remove btoa/atob bridge from `globals.ts` (now provided by `abab` polyfill)

## 4. Remove fetch from ActionContext and SDK

- [x] 4.1 Remove `fetch` method and its logging wrapper from `packages/runtime/src/context/index.ts`
- [x] 4.2 Remove `fetch` parameter from `createActionContext` factory function
- [x] 4.3 Update `ActionContext` type in SDK (`packages/sdk/src/index.ts`) — remove `fetch` from the interface
- [x] 4.4 Update all callers of `createActionContext` to stop passing fetch (scheduler, tests)

## 5. Migrate workflow actions

- [x] 5.1 Update `workflows/cronitor.ts` — change `ctx.fetch(url, init)` to `fetch(url, init)` in `sendMessage` handler

## 6. Update tests

- [x] 6.1 Update sandbox tests — replace `ctx.fetch` test cases with `__hostFetch` bridge tests (polyfills not tested in unit tests, only bridged functions)
- [x] 6.2 Add test: `__hostFetch` returns status, statusText, headers, body
- [x] 6.3 Add test: `__hostFetch` passes method, url, headers, body to host fetch
- [x] 6.4 Add test: `__hostFetch` bridge produces LogEntry with `method: "xhr.send"`
- [x] 6.5 Security test for Node.js globals already exists (sandbox isolation tests unchanged)
- [x] 6.6 Update integration tests and scheduler tests for ActionContext without fetch
- [x] 6.7 Run `pnpm validate` — all lint, format, typecheck, and tests pass
