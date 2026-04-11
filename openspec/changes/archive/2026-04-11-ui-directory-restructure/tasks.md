## 1. Create directory structure

- [x] 1.1 Create `src/ui/`, `src/ui/dashboard/`, `src/ui/trigger/` directories

## 2. Move files

- [x] 2.1 Move `src/views/layout.ts` → `src/ui/layout.ts`
- [x] 2.2 Move `src/dashboard/middleware.ts` → `src/ui/dashboard/middleware.ts`
- [x] 2.3 Move `src/dashboard/queries.ts` → `src/ui/dashboard/queries.ts`
- [x] 2.4 Move `src/dashboard/queries.test.ts` → `src/ui/dashboard/queries.test.ts`
- [x] 2.5 Move `src/dashboard/views/page.ts` → `src/ui/dashboard/page.ts` (flatten)
- [x] 2.6 Move `src/dashboard/views/list.ts` → `src/ui/dashboard/list.ts` (flatten)
- [x] 2.7 Move `src/dashboard/views/timeline.ts` → `src/ui/dashboard/timeline.ts` (flatten)
- [x] 2.8 Move `src/dashboard/views/timeline.test.ts` → `src/ui/dashboard/timeline.test.ts` (flatten)
- [x] 2.9 Move `src/trigger/middleware.ts` → `src/ui/trigger/middleware.ts`
- [x] 2.10 Move `src/trigger/middleware.test.ts` → `src/ui/trigger/middleware.test.ts`

## 3. Update import paths

- [x] 3.1 Update `src/main.ts`: `./dashboard/middleware.js` → `./ui/dashboard/middleware.js`, `./trigger/middleware.js` → `./ui/trigger/middleware.js`
- [x] 3.2 Update `src/ui/dashboard/middleware.ts`: `../event-bus/event-store.js` → `../../event-bus/event-store.js`, `../triggers/http.js` → `../../triggers/http.js`, `./views/page.js` → `./page.js`, `./views/list.js` → `./list.js`, `./views/timeline.js` → `./timeline.js`
- [x] 3.3 Update `src/ui/dashboard/queries.ts`: `../event-bus/event-store.js` → `../../event-bus/event-store.js`
- [x] 3.4 Update `src/ui/dashboard/queries.test.ts`: `../event-bus/index.js` → `../../event-bus/index.js`, `../event-bus/event-store.js` → `../../event-bus/event-store.js`
- [x] 3.5 Update `src/ui/dashboard/page.ts`: `../../views/layout.js` → `../layout.js`
- [x] 3.6 Update `src/ui/dashboard/list.ts`: `../queries.js` → `./queries.js`
- [x] 3.7 Update `src/ui/dashboard/timeline.ts`: `../queries.js` → `./queries.js`
- [x] 3.8 Update `src/ui/dashboard/timeline.test.ts`: `../queries.js` → `./queries.js`
- [x] 3.9 Update `src/ui/trigger/middleware.ts`: `../event-source.js` → `../../event-source.js`, `../triggers/http.js` → `../../triggers/http.js`, `../context/errors.js` → `../../context/errors.js`, `../views/layout.js` → `../layout.js`

## 4. Clean up and validate

- [x] 4.1 Delete empty directories: `src/views/`, `src/dashboard/`, `src/trigger/`
- [x] 4.2 Run `pnpm validate` — all lint, format, type check, and tests must pass
