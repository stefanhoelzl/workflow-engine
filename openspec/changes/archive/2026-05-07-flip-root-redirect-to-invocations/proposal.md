## Why

Invocations is the surface users return to most often — it's where they verify a workflow ran, drill into errors, and watch live activity. The current `GET /` → `/trigger` redirect lands new arrivals on the manual-fire form, which is a less useful default than the activity view.

## What Changes

- Flip the root redirect: `GET /` → `302 /invocations` (was `/trigger`).
- Update the `http-server` spec scenario to reflect the new target.
- Update the cross-reference in `auth/spec.md` §"Sign-out lands on /login" so the chain it documents (`/` → authenticated surface → sessionMw → /login → silent re-auth) names `/invocations` instead of `/trigger`. The load-bearing sign-out behavior (logout redirects to `/login` with a flash) is unchanged — the silent-reauth risk is identical regardless of which authenticated surface is the redirect target.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `http-server`: root-redirect target changes from `/trigger` to `/invocations`.
- `auth`: prose cross-reference updated to name the new redirect target. No requirement change.

## Impact

- `packages/runtime/src/services/server.ts` — one-line change at the root redirect handler.
- `packages/runtime/src/services/server.test.ts` — assertion + scenario name updated.
- `openspec/specs/http-server/spec.md` — scenario name and assertion updated.
- `openspec/specs/auth/spec.md` — prose reference updated.
- No code changes outside the runtime package. No SDK, sandbox, manifest, or EventBus impact. The `/trigger` surface itself remains fully functional and reachable; only the root redirect target moves.
- Auth integration tests that exercise returnTo with `/trigger` as a chosen protected resource (`auth/integration.test.ts`) are unaffected — they assert returnTo plumbing, not the root redirect.
