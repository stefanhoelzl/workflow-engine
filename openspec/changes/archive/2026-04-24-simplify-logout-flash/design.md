## Context

`GET /login` renders a flash banner in two cases: after a successful `POST /auth/logout` (`logged-out` flash) and after a GitHub OAuth callback rejects an unauthorized login (`denied` flash). Today each case appends provider-specific addenda via two optional `AuthProvider` hooks — `renderFlashBody()` and `renderFlashAction()` — which only the GitHub provider implements. The addenda are:

- an extra body sentence: *"GitHub may still consider this browser signed in to your GitHub account — sign out of GitHub too if you want to fully end the session or switch accounts."*
- a styled action button: *"Sign out of GitHub"* linking to `https://github.com/logout`.

The user-reported problem is that this bundle, rendered *immediately after* clicking our own "Sign out", reads as if signing out of our app did or should have ended the GitHub session. It cannot: the GitHub session cookie is first-party on `github.com` and no first-party origin can clear it from a third-party render. There is no OIDC `end_session_endpoint` (GitHub OAuth is non-OIDC) and no `prompt=login` / `prompt=select_account` supported by GitHub's authorize endpoint. Any "implicit GitHub logout" we could implement from our domain either fails silently (cross-origin cookie clearing) or degrades UX (forced redirect to `github.com/logout` without a guaranteed `return_to`).

The `denied` flash is where the link is genuinely load-bearing: because GitHub silently re-authenticates with the existing session, a user who landed on our app as the wrong GitHub user (e.g., wrong account in their browser) will loop through denial every time they click "Sign in with GitHub" unless they first sign out of github.com. But the styled action-area button, sitting next to our "Sign in with GitHub" button, still encourages the same confused mental model.

## Goals / Non-Goals

**Goals:**
- Eliminate the "my logout didn't actually log me out" confusion on the `logged-out` flash by removing the GitHub-specific addenda entirely.
- Preserve an escape hatch for the wrong-GitHub-account case on the `denied` flash, but recast it as account-switching guidance (inline prose link) rather than a parallel action affordance (styled button).
- Delete the now-unused `AuthProvider.renderFlashBody` / `renderFlashAction` hooks, the `FlashPayload.provider` field, and the plumbing that existed only to route flash-addendum rendering through the provider registry.
- Update `openspec/specs/auth/spec.md` to match.

**Non-Goals:**
- Implementing any form of "implicit" GitHub signout (iframe tricks, token revocation, forced redirect to `github.com/logout`). Investigated in the exploration phase and rejected: none of them actually end the browser's `github.com` session from our origin, and those that come closest (forced off-site redirect) degrade UX materially.
- Adding a generic `renderFlashContent` or other new provider hook "for future use". The change deletes hooks; it does not re-introduce them under a new name. Per project convention (`CLAUDE.md`: *"Don't design for hypothetical future requirements"*), if a future provider needs flash addenda the hook can be reintroduced at that point.
- Changing the `FlashPayload` discriminator, cookie name, TTL, seal scheme, or any other flash-cookie mechanic. Only the `provider` field is removed.
- Changing how `POST /auth/logout` authenticates (it is already unauthenticated by spec) or what cookies it clears.

## Decisions

### Decision: Remove `renderFlashBody` / `renderFlashAction` hooks instead of making them no-ops

**Rationale.** After this change no provider implements these hooks. Leaving the optional methods in the `AuthProvider` interface as a hypothetical extension point violates the project's "don't design for hypothetical future requirements" norm. The `FlashPayload.provider` field exists *only* to let `GET /login` resolve the right provider to call the hooks on — once the hooks are gone, the field has no consumer either, and its removal simplifies the `/auth/logout` handler (which currently unseals the session cookie just to read `provider`) and the GitHub callback's denied branch (which currently stamps `provider: "github"`).

**Alternatives considered.**
- *Keep the hooks, return nothing from GitHub's implementations.* Rejected — adds surface area that exists only on paper. Future readers would wonder why the interface exposes unused extension points.
- *Keep `FlashPayload.provider` as informational metadata.* Rejected — no reader after this change. Dead fields rot.

### Decision: The `denied` banner retains a GitHub signout link, but as an inline prose anchor inside the banner body

**Rationale.** The wrong-GitHub-account loop is a real UX failure mode we should not inflict on users. However, the *styling* of today's affordance — a full `btn btn--secondary` action-area button placed next to "Sign in with GitHub" — is what creates the bundled mental model ("these are two parallel things you might want to do right now"). Demoting it to an inline `<a>` inside the banner body, framed as "to try a different account, [sign out of GitHub] first", recasts it correctly: a remedial step that only matters if you arrived here as the wrong GitHub user. The `logged-out` banner gets no such link at all, because in that case the user deliberately clicked our "Sign out" — no account-switching context applies.

**Alternatives considered.**
- *Remove the link from `denied` too and document the workaround.* Rejected — users stuck in the silent re-auth loop would have no in-app hint at all.
- *Auto-redirect `/auth/logout` and the denied callback to `https://github.com/logout`.* Rejected during exploration. `github.com/logout` does not honor third-party `return_to` and requires a POST with a CSRF token; a GET-302 lands the user on a GitHub confirmation page that, once clicked, dumps them on `github.com` home with no path back. That is materially worse UX than a visible inline hint.
- *Revoke the OAuth token server-side.* Rejected — revokes the grant, not the `github.com` session cookie. Does not solve account switching and would only force a re-consent screen on the same user.

### Decision: The inline `<a>` on the `denied` banner targets `https://github.com/logout` with `target="_blank" rel="noopener noreferrer"`

**Rationale.** Matches the existing button's target semantics so users don't lose their `/login` tab. `noopener noreferrer` is required: without `noopener` a cross-origin `target="_blank"` page gets a `window.opener` reference to our page (phishing vector); `noreferrer` avoids leaking our `Referer` to GitHub. No CSP concerns — it is a plain anchor, not inline script or style.

### Decision: `POST /auth/logout` becomes stateless with respect to the session cookie contents

**Rationale.** Today the handler unseals the session cookie solely to read `session.provider` so it can stamp `provider` on the flash. With `FlashPayload.provider` removed, the unseal step has no purpose. The handler reduces to: clear the session cookie, seal a `{ kind: "logged-out" }` flash, set the flash cookie, 302 to `/login`. This also eliminates a (previously harmless but now gratuitous) cryptographic operation on the logout path and simplifies failure handling — there is nothing to `try/catch` around unseal.

## Risks / Trade-offs

- **Risk**: Users who currently use the "Sign out of GitHub" button as a convenience after logout lose that shortcut. → **Mitigation**: The `/login` page is a terminal page; users who want to end the github.com session can do so in any other tab. This matches every other GitHub-authenticated web service (Vercel, Netlify, etc. — none of them render a "sign out of GitHub too" affordance on their own logout).
- **Risk**: Users hitting `denied` who don't notice the inline prose link will keep clicking "Sign in with GitHub" and loop. → **Mitigation**: The denied banner already says "Contact the administrator if you believe this is an error", which frames the expected user action as "stop trying" for the common case. The inline account-switch link serves the less common case without being prominent. If telemetry later shows a loop problem we can revisit prominence without re-introducing the hooks.
- **Trade-off**: Small spec surface area reduction (hooks + field removed) at the cost of a one-time breaking change to the `AuthProvider` interface. Since `AuthProvider` is an internal type not published from any package, external impact is zero.

## Migration Plan

- **Deploy**: No data migration. Flash cookies are single-use and 60 seconds TTL; any cookies in flight at deploy time either predate the old format (no `provider` field yet — already optional on `logged-out`) or carry the about-to-be-ignored field (harmless — the Zod schema for `FlashPayload` will be updated to drop it, and any sealed cookie with an extra field will either be accepted by `.passthrough()` behaviour or fail unseal and fall through to the no-flash path, which is acceptable for a single-use cookie).
- **Rollback**: Revert the change set. No forward-only state is written.

## Open Questions

None after exploration. All branches were resolved in the interview phase (`logged-out` drops everything; `denied` keeps an inline link; hooks and `provider` field are deleted; no implicit signout mechanism is attempted).
