import { describe, expect, test } from "@workflow-engine/tests";

// Test — cold start from the libSQL event store.
//
// Verifies the durable round-trip: fire a trigger, observe its terminal
// commit, restart the runtime gracefully, and confirm the historical row is
// still queryable from the libSQL `events.db` after respawn.

describe("cold start from the libSQL event store", () => {
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
