## 1. Code

- [x] 1.1 Change `packages/runtime/src/services/server.ts:44` redirect target from `/trigger` to `/invocations`.

## 2. Tests

- [x] 2.1 Update `packages/runtime/src/services/server.test.ts` "createApp — root redirect" describe block: rename the `it("GET / returns 302 to /trigger", …)` scenario to `/invocations` and flip the `Location` assertion to `/invocations`.
- [x] 2.2 Confirm `pnpm test` (filtered to `services/server.test.ts`) passes.

## 3. Specs

- [x] 3.1 Update `openspec/specs/http-server/spec.md` "Requirement: Root redirect": flip the redirect target sentence to `/invocations`, rename scenario `Root redirects to /trigger` → `Root redirects to /invocations` with the matching assertion, and update the `Non-root paths are not redirected` example from `GET /invocations` to `GET /trigger` (so the example still names a non-root path).
- [x] 3.2 Update `openspec/specs/auth/spec.md` "Requirement: Logout route" prose paragraph: rename `/trigger` → `/invocations` in the silent-reauth chain explanation. No scenario or behavior change.

## 4. Dev probe

- [x] 4.1 Boot `pnpm dev --random-port --kill` (background); after the `[READY]` marker, `curl -sI http://localhost:<port>/` and confirm `HTTP/1.1 302` with `Location: /invocations`.
- [x] 4.2 Confirm `curl -sI http://localhost:<port>/trigger` still returns a redirect to `/login?returnTo=%2Ftrigger` (i.e. `/trigger` remains a reachable, session-guarded surface).
- [x] 4.3 Kill the dev process tree.

## 5. Validate

- [x] 5.1 `pnpm validate` passes (lint, check, test, tofu fmt + validate).
- [x] 5.2 `pnpm exec openspec validate flip-root-redirect-to-invocations --strict` passes.
