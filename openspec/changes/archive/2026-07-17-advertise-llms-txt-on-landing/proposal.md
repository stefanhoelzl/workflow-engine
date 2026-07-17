## Why

The platform ships a static `/llms.txt` docs index so an agent can discover how to author and deploy workflows, but nothing steers an agent there. Claude Code's WebFetch does not auto-probe `/llms.txt`; handed the bare domain it follows `/` → `/invocations` → `/login` and renders the Sign-in page, which contains no pointer to the docs. The `llm-docs` capability promises agents can "discover ... docs" yet has no requirement covering discovery from the unauthenticated landing — a real gap that makes the shipped `/llms.txt` effectively unreachable unless a human already knows the exact URL.

## What Changes

- The unauthenticated landing pages an agent actually lands on — the login page and the 404 / 5xx error pages — carry a machine-discoverable pointer to `/llms.txt`.
- The pointer is a **screen-reader-only** in-DOM anchor (`<a class="sr-only" href="/llms.txt">…</a>`) plus a `<link rel="alternate" type="text/markdown" href="/llms.txt">` in `<head>`. The sr-only anchor is invisible to sighted users but survives WebFetch's HTML→markdown extraction (verified empirically against a real page using the same clip-rect technique); the head link serves llmstxt-convention crawlers.
- A reusable `.sr-only` utility class is added to `workflow-engine.css` (the existing `.sr-live` is semantically a live region).
- No change to the `/llms.txt` route itself, no new sandbox globals, no EventBus/manifest impact, no CSP change (the anchor and head link are static markup — no inline script/style).

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `llm-docs`: add a requirement that the unauthenticated landing surface advertises the `/llms.txt` index to agents via an in-DOM visually-hidden link and a `<head>` alternate link, as a fixed constant reflecting no request input.
- `auth`: the **Login page route** now renders the `/llms.txt` discovery pointer (sr-only anchor + head alternate link).
- `ui-errors`: the **404 page outcome** and **5xx error page outcome** now render the `/llms.txt` discovery pointer.

## Impact

- `packages/runtime/src/ui/auth/login-page.tsx` — add head alternate link + sr-only anchor.
- `packages/runtime/src/ui/error-pages.tsx` — add head alternate link + sr-only anchor to the shared `ErrorShell` (covers 404 + 5xx).
- `packages/runtime/src/ui/static/workflow-engine.css` — add `.sr-only` utility; keep `docs/ui-guidelines.md` in sync.
- A small shared component/constant for the pointer markup, reused by both render paths.
- Tests: assert the anchor + head link appear in the rendered login and error HTML.
- No infra, deployment, or security-posture change.
