import type { InvocationEvent } from "@workflow-engine/core";
import { makeEvent } from "@workflow-engine/core/test-utils";
import { describe, expect, it } from "vitest";
import { withZodSchemas } from "../triggers/test-descriptors.js";
import type { WorkflowEntry } from "../workflow-registry.js";
import { LoginPage } from "./auth/login-page.js";
import { renderFlamegraph } from "./dashboard/flamegraph.js";
import {
	type InvocationRow,
	renderDashboardPage,
	renderInvocationList,
} from "./dashboard/page.js";
import { ErrorPage, NotFoundPage } from "./error-pages.js";
import { renderRepoTriggerPage } from "./trigger/page.js";

const notFoundHtml = String(NotFoundPage());
const errorHtml = String(ErrorPage());

// Universal-topbar contract assertions (ui-foundation): wordmark always
// renders inside .topbar-brand; user section appears only when user prop
// is supplied. The brand-mark SVG element no longer exists; the wordmark
// is text-only in --accent.

// ---------------------------------------------------------------------------
// CSP invariant assertions (SECURITY.md §6)
// ---------------------------------------------------------------------------
//
// Every HTML renderer must satisfy these constraints:
//   - No <script> tags with inline content (application/json is data, not
//     executable — those are allowed).
//   - No on\w+= event-handler attributes.
//   - No style= inline style attributes.
//   - No javascript: URLs.

const INLINE_SCRIPT_RE =
	/<script(?![^>]*type="application\/json")[^>]*>[^<]+<\/script>/i;
const EVENT_HANDLER_RE = /\bon\w+\s*=/i;
const INLINE_STYLE_RE = /\bstyle\s*=/i;
const JAVASCRIPT_URL_RE = /javascript\s*:/i;
const DATA_TIMER_ID_7_RE = /data-timer-id="7"/;
const DATA_EVENT_PAIR_0_6_RE = /data-event-pair="0-6"/;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeWorkflowEntry(): WorkflowEntry {
	return {
		owner: "t0",
		repo: "r0",
		workflow: {
			name: "w",
			module: "w.js",
			sha: "0".repeat(64),
			env: {},
			actions: [],
			triggers: [],
		},
		bundleSource: "",
		triggers: [
			withZodSchemas({
				kind: "http",
				type: "http",
				name: "t",
				workflowName: "w",
				method: "POST",
				request: {
					body: {
						type: "object",
						properties: { id: { type: "string" } },
					},
					headers: {
						type: "object",
						properties: {},
						additionalProperties: false,
					},
				},
				inputSchema: {
					type: "object",
					properties: { body: { type: "object" } },
				},
				outputSchema: { type: "object" },
			}),
		],
	};
}

const sampleRows: readonly InvocationRow[] = [
	{
		id: "evt_1",
		owner: "t0",
		repo: "r0",
		workflow: "w",
		trigger: "t",
		status: "succeeded",
		startedAt: "2026-01-01T00:00:00Z",
		completedAt: "2026-01-01T00:00:01Z",
		startedTs: 0,
		completedTs: 1_000_000,
	},
	{
		id: "evt_2",
		owner: "t0",
		repo: "r0",
		workflow: "w",
		trigger: "t",
		status: "pending",
		startedAt: "2026-01-01T00:00:00Z",
		completedAt: null,
		startedTs: 0,
		completedTs: null,
	},
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HTML CSP invariants", () => {
	it("renderDashboardPage (shell) output has no forbidden inline patterns", async () => {
		const html = (
			await renderDashboardPage({
				user: "user",
				email: "user@example.com",
				owners: ["acme"],
				rows: [],
			})
		).toString();
		expect(html).not.toMatch(INLINE_SCRIPT_RE);
		expect(html).not.toMatch(EVENT_HANDLER_RE);
		expect(html).not.toMatch(INLINE_STYLE_RE);
		expect(html).not.toMatch(JAVASCRIPT_URL_RE);
	});

	it("renderInvocationList (fragment) output has no forbidden inline patterns", async () => {
		const html = (await renderInvocationList(sampleRows)).toString();
		expect(html).not.toMatch(INLINE_SCRIPT_RE);
		expect(html).not.toMatch(EVENT_HANDLER_RE);
		expect(html).not.toMatch(INLINE_STYLE_RE);
		expect(html).not.toMatch(JAVASCRIPT_URL_RE);
	});

	it("renderInvocationList (empty) output has no forbidden inline patterns", async () => {
		const html = (await renderInvocationList([])).toString();
		expect(html).not.toMatch(INLINE_SCRIPT_RE);
		expect(html).not.toMatch(EVENT_HANDLER_RE);
		expect(html).not.toMatch(INLINE_STYLE_RE);
		expect(html).not.toMatch(JAVASCRIPT_URL_RE);
	});

	it("renderRepoTriggerPage output has no forbidden inline patterns", async () => {
		const entries: WorkflowEntry[] = [makeWorkflowEntry()];
		const html = (
			await renderRepoTriggerPage({
				entries,
				user: "user",
				email: "user@example.com",
				owners: ["t0"],
				owner: "t0",
				repo: "r0",
			})
		).toString();
		expect(html).not.toMatch(INLINE_SCRIPT_RE);
		expect(html).not.toMatch(EVENT_HANDLER_RE);
		expect(html).not.toMatch(INLINE_STYLE_RE);
		expect(html).not.toMatch(JAVASCRIPT_URL_RE);
	});

	it("renderFlamegraph (empty) output has no forbidden inline patterns", async () => {
		const html = (await renderFlamegraph([])).toString();
		expect(html).not.toMatch(INLINE_SCRIPT_RE);
		expect(html).not.toMatch(EVENT_HANDLER_RE);
		expect(html).not.toMatch(INLINE_STYLE_RE);
		expect(html).not.toMatch(JAVASCRIPT_URL_RE);
	});

	it("404.html has no forbidden inline patterns", () => {
		expect(notFoundHtml).not.toMatch(INLINE_SCRIPT_RE);
		expect(notFoundHtml).not.toMatch(EVENT_HANDLER_RE);
		expect(notFoundHtml).not.toMatch(INLINE_STYLE_RE);
		expect(notFoundHtml).not.toMatch(JAVASCRIPT_URL_RE);
		expect(notFoundHtml).not.toMatch(/<style\b/i);
		expect(notFoundHtml).toContain('href="/static/workflow-engine.css"');
		expect(notFoundHtml).not.toContain("/static/error.css");
	});

	it("error.html has no forbidden inline patterns", () => {
		expect(errorHtml).not.toMatch(INLINE_SCRIPT_RE);
		expect(errorHtml).not.toMatch(EVENT_HANDLER_RE);
		expect(errorHtml).not.toMatch(INLINE_STYLE_RE);
		expect(errorHtml).not.toMatch(JAVASCRIPT_URL_RE);
		expect(errorHtml).not.toMatch(/<style\b/i);
		expect(errorHtml).toContain('href="/static/workflow-engine.css"');
	});

	it("NotFoundPage with no user renders the wordmark but no user section", () => {
		expect(notFoundHtml).toContain('class="topbar-brand"');
		expect(notFoundHtml).toContain("Workflow Engine");
		expect(notFoundHtml).not.toContain('class="topbar-user"');
		expect(notFoundHtml).not.toContain('class="brand-mark"');
	});

	it("NotFoundPage with user renders the user section in the topbar", () => {
		const html = String(
			NotFoundPage({ user: "alice", email: "alice@example.com" }),
		);
		expect(html).toContain('class="topbar-brand"');
		expect(html).toContain("Workflow Engine");
		expect(html).toContain('class="topbar-user"');
		expect(html).toContain("alice");
		expect(html).toContain("alice@example.com");
	});

	it("ErrorPage with no user renders the wordmark but no user section", () => {
		expect(errorHtml).toContain('class="topbar-brand"');
		expect(errorHtml).toContain("Workflow Engine");
		expect(errorHtml).not.toContain('class="topbar-user"');
		expect(errorHtml).not.toContain('class="brand-mark"');
	});

	it("LoginPage is a self-contained card with brand in the heading", () => {
		const html = String(
			LoginPage({ flash: undefined, returnTo: "/", sections: [] }),
		);
		// Login page intentionally omits the universal topbar; branding is
		// carried by the heading via .auth-card__brand.
		expect(html).not.toContain('class="topbar"');
		expect(html).not.toContain('class="topbar-brand"');
		expect(html).not.toContain('class="topbar-user"');
		expect(html).toContain('class="auth-card__brand"');
		expect(html).toContain("Workflow Engine");
	});

	it("renderDashboardPage with user renders the user section", async () => {
		const html = (
			await renderDashboardPage({
				user: "alice",
				email: "alice@example.com",
				owners: ["acme"],
				rows: [],
			})
		).toString();
		expect(html).toContain('class="topbar-brand"');
		expect(html).toContain('class="topbar-user"');
		expect(html).toContain("alice");
		expect(html).not.toContain('class="brand-mark"');
	});

	it("renderFlamegraph (populated) output has no forbidden inline patterns", async () => {
		const events: InvocationEvent[] = [
			makeEvent({ kind: "trigger.request", seq: 0, ts: 0 }),
			makeEvent({
				kind: "action.request",
				seq: 1,
				ref: 0,
				ts: 100,
				name: "sendEmail",
			}),
			makeEvent({
				kind: "system.call",
				seq: 2,
				ref: 1,
				ts: 120,
				name: "setTimeout",
				input: { timerId: 7, delay: 50 },
			}),
			makeEvent({
				kind: "action.response",
				seq: 3,
				ref: 1,
				ts: 180,
				name: "sendEmail",
			}),
			makeEvent({
				kind: "system.request",
				seq: 4,
				ref: null,
				ts: 200,
				name: "setTimeout",
				input: { timerId: 7 },
			}),
			makeEvent({
				kind: "system.response",
				seq: 5,
				ref: 4,
				ts: 250,
				name: "setTimeout",
				input: { timerId: 7 },
			}),
			makeEvent({ kind: "trigger.response", seq: 6, ref: 0, ts: 500 }),
		];
		const html = (await renderFlamegraph(events)).toString();
		expect(html).not.toMatch(INLINE_SCRIPT_RE);
		expect(html).not.toMatch(EVENT_HANDLER_RE);
		expect(html).not.toMatch(INLINE_STYLE_RE);
		expect(html).not.toMatch(JAVASCRIPT_URL_RE);
		// Kind classes + timer data attrs are present
		expect(html).toContain("kind-trigger");
		expect(html).toContain("kind-action");
		expect(html).toContain("kind-rest");
		expect(html).toMatch(DATA_TIMER_ID_7_RE);
		// Paired bars carry data-event-pair
		expect(html).toMatch(DATA_EVENT_PAIR_0_6_RE);
	});
});
