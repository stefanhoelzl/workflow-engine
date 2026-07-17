## Context

`/llms.txt` ships (route in `packages/runtime/src/services/server.ts`, body in `services/llms-txt.ts`) but is unreachable-by-discovery. Claude Code's WebFetch does not auto-probe `/llms.txt`; it fetches the literal URL given. Handed the bare domain, WebFetch follows same-host redirects `/` → `/invocations` → `/login` and renders the Sign-in page (`ui/auth/login-page.tsx`), which points nowhere. A wrong path renders the shared error shell (`ui/error-pages.tsx`). Neither surface references the docs.

The `llm-docs` spec's Purpose already claims agents can "discover" the docs, so this closes a real gap rather than adding scope.

Empirical basis for the approach: WebFetch converts a fetched page to markdown via a small model. Tested against a real page (github.com) that hides text with the same clip-rect `sr-only` technique — 5/5 visually-hidden strings surfaced in WebFetch's extracted content and were read back. So class-based visually-hidden text survives the pipeline; `display:none` / `hidden` / `aria-hidden` / `<script>` / `<style>` are what extractors strip. (A claude.ai-artifact test was discarded as unfaithful: WebFetch returns raw HTML for artifact URLs and skips the markdown pipeline entirely.)

## Goals / Non-Goals

**Goals:**
- An agent handed only `workflow-engine.stho.net` and told to "read it" surfaces `/llms.txt` without a human supplying the exact path.
- Zero visible change to the login and error pages for sighted users.
- No CSP change, no new route, no request-input reflection.

**Non-Goals:**
- Client-side auto-discovery (out of our control — Claude Code does not implement it).
- Changing root `/` redirect behavior or the `/llms.txt` route itself.
- Advertising the pointer on authenticated pages (an agent in the bare-domain scenario never reaches them; deferred).
- `robots.txt` (no standard llms field; Claude Code ignores it).

## Decisions

**D1 — Screen-reader-only anchor as the primary pointer, over a visible footer link.**
The pointer must surface to WebFetch without cluttering the human UI. A clip-rect `sr-only` anchor (`position:absolute; 1px; clip:rect(0,0,0,0)`) is in the DOM (survives extraction, per the empirical test) yet invisible to sighted users, and is legitimate a11y markup rather than `display:none` cloaking. Rejected: a visible footer (adds human-facing chrome for a bot-facing need); head `<link>` alone (WebFetch strips head links — reproduces today's failure).

**D2 — Add a `<link rel="alternate" type="text/markdown" href="/llms.txt">` in `<head>` as well.**
WebFetch ignores it, but it is the llmstxt-adjacent convention for crawlers/tools that parse head links. Two cheap, CSP-safe lines; future-proofs for non-Claude agents. Both pointer forms are fixed constants — no request input, consistent with the login page's existing "no reflection" posture and `llms-txt.ts`.

**D3 — Placement: login page + the shared error shell (404 + 5xx) only.**
These are exactly the unauthenticated surfaces the bare-domain follow-through lands on. Two render sites: `ui/auth/login-page.tsx` and `ui/error-pages.tsx`'s `ErrorShell` (which backs both `NotFoundPage` and `ErrorPage`, so one edit covers 404 and 5xx). Authenticated `Layout` is out of scope (D-Non-Goals).

**D4 — New `.sr-only` utility in `workflow-engine.css`; do not overload `.sr-live`.**
`.sr-live` exists but is semantically a screen-reader live region for copy confirmations. Add a general-purpose `.sr-only` with the same clip-rect rules. This touches `workflow-engine.css`, so `docs/ui-guidelines.md` is updated in the same change (per CLAUDE.md CSS convention). No `ui-foundation` behavior contract changes (theme/motion/CSP/topbar all unaffected).

**D5 — Share the markup via a tiny component/constant.**
A small `LlmsDiscovery`-style helper exports the body anchor (JSX) reused by both render sites; the `<head>` `<link>` is added to each of the two heads (only two, so a shared head-fragment is optional). Keeps the directive wording in one place, e.g. *"AI agents and LLMs: Workflow Engine's machine-readable docs for authoring and deploying workflows are at /llms.txt."*

**D6 — Verification: unit test + one post-deploy WebFetch on staging.**
Unit tests assert the anchor (`href="/llms.txt"`, `sr-only` class) and the head `<link>` appear in the rendered login and error HTML, and that the anchor is not `display:none`/`hidden`/`aria-hidden`. WebFetch cannot reach `localhost`, so the only faithful end-to-end check is against a public URL: after merge auto-deploys staging, run one WebFetch against `https://<staging>/login` (and a 404 path) confirming the model can name `/llms.txt`.

## Risks / Trade-offs

- **[sr-only stripped by a future WebFetch extractor change] →** Mitigated by the empirical GitHub test (current behavior) plus the post-deploy staging WebFetch check; if it ever regresses, the pre-agreed fallback is a visible muted footer link (cheap follow-up), and the head `<link>` remains for convention crawlers.
- **[Cloaking / bot-only-content perception] →** The anchor is standard a11y markup readable by assistive tech, not deceptive content served only to bots; wording is honest and points at a genuinely public docs index.
- **[CSP regression] →** None: the anchor and head link are static markup with no inline script/style/`on*=`/`style=`. Existing CSP-clean scenarios in `ui-errors`/`auth` continue to cover this and the new tests assert it.
- **[Redundant scenarios across llm-docs / auth / ui-errors] →** Intentional: each capability's page contract stays self-contained and independently testable; the `llm-docs` requirement is the normative source, the auth/ui-errors deltas restate the per-page assertion.
