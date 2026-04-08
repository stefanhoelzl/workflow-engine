## 1. Remove SSE consumer

- [x] 1.1 Delete `packages/runtime/src/dashboard/sse-consumer.ts`
- [x] 1.2 Delete `packages/runtime/src/dashboard/sse-consumer.test.ts`

## 2. Remove SSE from middleware

- [x] 2.1 Remove `createSseResponse()` function and `/dashboard/events` route from `middleware.ts`
- [x] 2.2 Remove `htmxSseJs` import/readFileSync and `/htmx-sse.js` route from `middleware.ts`
- [x] 2.3 Remove `SseConsumer` parameter from `dashboardMiddleware` function signature

## 3. Simplify view rendering

- [x] 3.1 Remove `oob` parameter and OOB swap attributes from `renderEntryRow` in `views/list.ts`
- [x] 3.2 Remove dedup `x-init` logic from `renderEntryRow`
- [x] 3.3 Remove `oob` parameter and `hx-swap-oob` attribute from `renderHeaderStats`

## 4. Simplify page shell

- [x] 4.1 Remove `htmx-ext-sse` script tag from `views/page.ts`
- [x] 4.2 Remove `#sse-container` div from `views/page.ts`
- [x] 4.3 Remove `htmx:oobAfterSwap` script block from `views/page.ts`

## 5. Remove wiring from main

- [x] 5.1 Remove `SseConsumer` creation and bus consumer registration from `main.ts`
- [x] 5.2 Update `dashboardMiddleware` call to remove `sseConsumer` argument

## 6. Remove dependency

- [x] 6.1 Remove `htmx-ext-sse` from `packages/runtime/package.json` and run `pnpm install`

## 7. Verify

- [x] 7.1 Run `pnpm lint`, `pnpm check`, and `pnpm test` — all pass
