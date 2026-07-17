## 1. Shared pointer markup + CSS

- [x] 1.1 Add a `.sr-only` utility class (clip-rect: `position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0`) to `packages/runtime/src/ui/static/workflow-engine.css`, near the existing `.sr-live`.
- [x] 1.2 Add a small shared helper (e.g. `packages/runtime/src/ui/shared/llms-discovery.tsx`) exporting the body anchor `<a class="sr-only" href="/llms.txt">…</a>` with the directive wording ("AI agents and LLMs: Workflow Engine's machine-readable docs for authoring and deploying workflows are at /llms.txt") and a head element `<link rel="alternate" type="text/markdown" href="/llms.txt" />`. Keep both as fixed constants (no request input).

## 2. Wire the pointer into the landing pages

- [x] 2.1 In `packages/runtime/src/ui/auth/login-page.tsx`, add the head `<link rel="alternate">` to `<head>` and render the `sr-only` anchor in `<body>` (before or inside `<main class="auth-card">`, not as a visible card element).
- [x] 2.2 In `packages/runtime/src/ui/error-pages.tsx`, add the head `<link rel="alternate">` and the `sr-only` anchor to the shared `ErrorShell` so both `NotFoundPage` (404) and `ErrorPage` (5xx) inherit it.
- [x] 2.3 Confirm no CSP violation: the anchor and head link carry no inline `style=`/`on*=`; classes only. Verify against the existing CSP-clean invariants.

## 3. Tests

- [x] 3.1 Unit test: `renderLoginPage(...)` output contains an anchor with `href="/llms.txt"` and the `sr-only` class, and the head contains `<link rel="alternate" type="text/markdown" href="/llms.txt">`; assert the anchor is NOT `display:none`/`hidden`/`aria-hidden`.
- [x] 3.2 Unit test: `NotFoundPage()` and `ErrorPage()` output each contain the `sr-only` `/llms.txt` anchor and the head alternate link.
- [x] 3.3 Ensure `packages/runtime/src/ui/html-invariants.test.ts` (CSP-clean / inline-free invariants) still passes for the updated login and error HTML; extend it if it enumerates page renderers.

## 4. Docs

- [x] 4.1 Update `docs/ui-guidelines.md` to document the new `.sr-only` utility class (alongside `.sr-live`).

## 5. Validation & verification

- [x] 5.1 Run `pnpm validate` (lint + check + test + tofu fmt/validate) and fix any drift.
- [x] 5.2 Dev probe: boot `pnpm dev --random-port --kill` (backgrounded), wait for the `[READY]` marker, then `curl -s http://localhost:<port>/login` and a 404 path (e.g. `/nonexistent`) and grep each for `class="sr-only"` + `href="/llms.txt"` and the head `<link rel="alternate" … href="/llms.txt">`. Tear down the process tree. — Verified on port 40971: both /login and /nonexistent carry the head alternate link + sr-only anchor; /llms.txt still 200 text/markdown.
- [ ] 5.3 Post-deploy verification (belt-and-suspenders, after merge → staging auto-deploy): WebFetch `https://<staging>/login` and a 404 path with a prompt like "what path should an AI agent fetch for docs?" and confirm the model names `/llms.txt`. If stripped, follow up with a visible muted footer link (fallback per design.md D6). Record the result in the PR summary.
