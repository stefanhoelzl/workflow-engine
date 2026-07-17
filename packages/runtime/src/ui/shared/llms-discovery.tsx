// Agent-discovery pointer to the static `/llms.txt` docs index, rendered on
// the unauthenticated landing surfaces (login page + 404/5xx error pages).
//
// An agent handed only the bare domain follows `/` -> `/invocations` ->
// `/login` (or lands on an error page for a wrong path). Claude Code's
// WebFetch does not auto-probe `/llms.txt`; it reads whatever page it lands
// on. So those pages carry a pointer:
//
//   - `LlmsDocsHeadLink` — a `<link rel="alternate" type="text/markdown">` in
//     `<head>` for llmstxt-convention crawlers that parse head links.
//   - `LlmsDocsPointer` — a visually-hidden (`sr-only`) in-DOM anchor that
//     survives WebFetch's HTML->markdown extraction (verified empirically) yet
//     stays invisible to sighted users. It is hidden via the clip-rect
//     `.sr-only` technique, NOT `display:none`/`hidden`/`aria-hidden`, which
//     extractors strip.
//
// Both are fixed constants: they reflect no request input, matching the
// static `/llms.txt` body itself (see services/llms-txt.ts). Neither carries
// inline script/style, so both stay CSP-clean (SECURITY.md §6).

const LLMS_TXT_PATH = "/llms.txt";

// Directive sentence naming the path so an extracting model acts on it.
const LLMS_POINTER_TEXT =
	"AI agents and LLMs: Workflow Engine's machine-readable docs for authoring and deploying workflows are at /llms.txt";

function LlmsDocsHeadLink() {
	return (
		<link
			rel="alternate"
			type="text/markdown"
			href={LLMS_TXT_PATH}
			title="LLM/agent docs index"
		/>
	);
}

function LlmsDocsPointer() {
	return (
		<a class="sr-only" href={LLMS_TXT_PATH}>
			{LLMS_POINTER_TEXT}
		</a>
	);
}

export { LlmsDocsHeadLink, LlmsDocsPointer };
