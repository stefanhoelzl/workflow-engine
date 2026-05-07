## Context

`packages/runtime/src/services/server.ts:44` registers a single root-redirect handler:

```ts
app.get("/", (c) => c.redirect("/trigger", HTTP_FOUND));
```

Both `/invocations` and `/trigger` are session-guarded UI surfaces; either is a valid landing target. The choice is a UX decision, not a structural one.

The auth spec's "Logout route" requirement contains a parenthetical paragraph describing the exact chain `/` → `redirect-root` → `/trigger` → `sessionMw` → `/login` → GitHub silent re-auth. That paragraph names the current target by URL, so it has to be updated alongside the code.

## Goals / Non-Goals

**Goals:**
- `GET /` redirects to `/invocations` so users land on the activity view, not the manual-fire form.
- The `http-server` and `auth` specs reflect the new target.

**Non-Goals:**
- Reorganising tabs, sidebar, or topbar (Invocations is already first in the tab order).
- Removing or remounting `/trigger`; it remains a fully functional surface, just no longer the default.
- Replacing the redirect with a direct render at `/` (would entangle invocations basePath; out of scope).
- Revisiting the logout-flash workaround. The silent-reauth risk is identical regardless of which authenticated surface `/` points at, so the flash mechanism stays as-is.

## Decisions

**Keep the redirect, just flip the target.** Alternatives considered: (a) mount the invocations root handler directly at `/`, (b) make the default configurable. Both add complexity for no concrete benefit — a 302 is cheap, the spec already documents it, and there is no operator demand for configurability.

**Scenario name change in `http-server`.** The current scenario is `Root redirects to /trigger`. Renaming to `Root redirects to /invocations` (rather than just changing the assertion under the same name) keeps the spec self-describing; tests in `server.test.ts` follow the same convention.

**Auth-spec update is prose-only.** The "Logout route" requirement's behavior is unchanged; only the explanatory paragraph that happens to name `/trigger` needs editing. No scenario changes.

## Risks / Trade-offs

- [Risk] Auth integration tests in `auth/integration.test.ts` assert `Location: /trigger` after sign-in. → No mitigation needed: those tests pass `returnTo=/trigger` explicitly to exercise the returnTo plumbing, not the root redirect. They continue to pass after the flip.
- [Risk] Bookmarks pointing at `/` continue to work; users land on a different page than before. → Acceptable; both pages are part of the authenticated UI and the activity view is more useful as a default.
- [Risk] Documentation drift if other docs name `/trigger` as the default. → `docs/dev-probes.md`, `README.md`, and `docs/infrastructure.md` were grep-checked: none mention `/` → `/trigger` as the default landing.
