import { describe, expect, it } from "vitest";
import type { WorkflowRunner } from "../executor/types.js";
import type { HttpTriggerEntry } from "../triggers/http.js";
import { renderDashboardPage } from "./dashboard/page.js";
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRunner(name: string): WorkflowRunner {
	return {
		name,
		env: {},
		actions: [],
		triggers: [],
		invokeHandler: async () => ({}),
	};
}

function makeTriggerEntry(): HttpTriggerEntry {
	return {
		workflow: makeRunner("w"),
		descriptor: {
			name: "t",
			type: "http",
			path: "w/t",
			method: "POST",
			params: [],
			body: { parse: (x: unknown) => x },
		},
		schema: {
			type: "object",
			properties: { body: { type: "object" } },
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HTML CSP invariants", () => {
	it("renderDashboardPage output has no forbidden inline patterns", async () => {
		const html = (
			await renderDashboardPage(
				[
					{
						id: "evt_1",
						workflow: "w",
						trigger: "t",
						status: "succeeded",
						startedAt: "2026-01-01T00:00:00Z",
						completedAt: "2026-01-01T00:00:01Z",
					},
				],
				"user",
				"user@example.com",
			)
		).toString();
		expect(html).not.toMatch(INLINE_SCRIPT_RE);
		expect(html).not.toMatch(EVENT_HANDLER_RE);
		expect(html).not.toMatch(INLINE_STYLE_RE);
		expect(html).not.toMatch(JAVASCRIPT_URL_RE);
	});

	it("renderTriggerPage output has no forbidden inline patterns", async () => {
		const entries: HttpTriggerEntry[] = [makeTriggerEntry()];
		const html = (
			await renderTriggerPage(entries, "user", "user@example.com")
		).toString();
		expect(html).not.toMatch(INLINE_SCRIPT_RE);
		expect(html).not.toMatch(EVENT_HANDLER_RE);
		expect(html).not.toMatch(INLINE_STYLE_RE);
		expect(html).not.toMatch(JAVASCRIPT_URL_RE);
	});
});
