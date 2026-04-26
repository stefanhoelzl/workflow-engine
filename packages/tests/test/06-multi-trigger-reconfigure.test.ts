import { describe, expect, test } from "@workflow-engine/tests";

// Test #6 — multi-backend reconfigure. One workflow registers BOTH an
// httpTrigger and a cronTrigger in a single upload; after the single
// upload, both backends must be reachable: the webhook fires the http
// trigger, and the cron source fires the cron trigger on its own.

describe("multi-backend reconfigure", () => {
	test("one upload arms both http and cron triggers", (s) =>
		s
			.workflow(
				"multi",
				`
import {httpTrigger, cronTrigger, z} from "@workflow-engine/sdk";

export const ping = httpTrigger({
	body: z.object({}),
	handler: async () => ({status: 200, body: "pong"}),
});

export const tick = cronTrigger({
	schedule: "* * * * * *",
	tz: "UTC",
	handler: async () => {},
});
`,
			)
			.waitForEvent({ trigger: "tick", kind: "trigger.response" })
			.webhook("ping", { body: {} })
			.waitForEvent({ trigger: "ping", kind: "trigger.response" })
			.expect((state) => {
				expect(state.uploads).toHaveLength(1);
				const up = state.uploads.byIndex(0);
				expect(up.workflows.map((w) => w.name)).toEqual(["multi"]);
				const ping = state.events.find(
					(e) => e.kind === "trigger.response" && e.name === "ping",
				);
				const tick = state.events.find(
					(e) => e.kind === "trigger.response" && e.name === "tick",
				);
				expect(ping).toBeDefined();
				expect(tick).toBeDefined();
				expect(state.responses).toHaveLength(1);
				expect(state.responses.byIndex(0)).toMatchObject({
					status: 200,
					body: "pong",
				});
			}));
});
