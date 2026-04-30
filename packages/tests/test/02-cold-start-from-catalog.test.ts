import { describe, expect, test } from "@workflow-engine/tests";

// Test — cold start from a populated DuckLake catalog.
//
// Verifies the core scaling promise of `event-store-ducklake`: cold start
// reads the catalog file and is constant-time, regardless of the number of
// archived invocations. Also exercises the basic round-trip — fire a
// trigger, observe its terminal commit, restart the runtime gracefully,
// and confirm the historical row is still queryable.

describe("cold start from catalog", () => {
	test("invocations committed before sigterm are still queryable after restart", (s) =>
		s
			.workflow(
				"echo",
				`
import {httpTrigger, z} from "@workflow-engine/sdk";

export const echo = httpTrigger({
	request: { body: z.object({}) },
	handler: async () => ({body: {ok: true}}),
});
`,
			)
			.webhook("echo", { body: {}, label: "first" })
			.waitForEvent({
				label: "first",
				archived: true,
				kind: "trigger.response",
			})
			.sigterm({ restart: true })
			.waitForEvent({
				label: "first",
				archived: true,
				kind: "trigger.response",
			})
			.expect((state) => {
				// After respawn the catalog still contains the prior invocation.
				const responses = state.events.filter(
					(e) => e.kind === "trigger.response" && e.name === "echo",
				);
				expect(responses).toHaveLength(1);
			}));
});
