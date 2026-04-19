import type { InvocationEvent } from "@workflow-engine/core";
import { makeEvent } from "@workflow-engine/core/test-utils";
import { describe, expect, it } from "vitest";
import type { WorkflowEntry } from "../workflow-registry.js";
import { renderFlamegraph } from "./dashboard/flamegraph.js";
import {
	type InvocationRow,
	renderDashboardPage,
	renderInvocationList,
} from "./dashboard/page.js";
import { renderTriggerPage } from "./trigger/page.js";

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
		tenant: "t0",
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
			{
				kind: "http",
				type: "http",
				name: "t",
				method: "POST",
				path: "w/t",
				params: [],
				body: { type: "object", properties: { id: { type: "string" } } },
				inputSchema: {
					type: "object",
					properties: { body: { type: "object" } },
				},
				outputSchema: { type: "object" },
			},
		],
	};
}

const sampleRows: readonly InvocationRow[] = [
	{
		id: "evt_1",
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
				tenants: ["acme"],
				activeTenant: "acme",
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

	it("renderTriggerPage output has no forbidden inline patterns", async () => {
		const entries: WorkflowEntry[] = [makeWorkflowEntry()];
		const html = (
			await renderTriggerPage({
				entries,
				user: "user",
				email: "user@example.com",
				tenants: ["t0"],
				activeTenant: "t0",
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
				kind: "timer.set",
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
				kind: "timer.request",
				seq: 4,
				ref: null,
				ts: 200,
				name: "setTimeout",
				input: { timerId: 7 },
			}),
			makeEvent({
				kind: "timer.response",
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
		expect(html).toContain("kind-timer");
		expect(html).toMatch(DATA_TIMER_ID_7_RE);
		// Paired bars carry data-event-pair
		expect(html).toMatch(DATA_EVENT_PAIR_0_6_RE);
	});
});
