import { describe, expect, test } from "@workflow-engine/tests";

// Test #16 — cronTrigger fires on a real wall-clock tick. Uploads a workflow
// with a 6-field every-second cron trigger, then `.waitForEvent` polls the
// spawned child's persistence dir for the resulting `trigger.response`.
// The framework's default hardCap (5000ms) bounds the wait; with a 1s cron
// cadence this should resolve in <2s under healthy load.

describe("cronTrigger fires", () => {
	test("every-second cron produces a trigger.response within hardCap", (s) =>
		s
			.workflow(
				"cronwf",
				`
import {cronTrigger} from "@workflow-engine/sdk";

export const tick = cronTrigger({
	schedule: "* * * * * *",
	tz: "UTC",
	handler: async () => {},
});
`,
			)
			.waitForEvent({ trigger: "tick", kind: "trigger.response" })
			.expect((state) => {
				const matched = state.events.find(
					(e) => e.kind === "trigger.response" && e.name === "tick",
				);
				expect(matched).toBeDefined();
				expect(matched?.owner).toBe("dev");
				expect(matched?.repo).toBe("e2e");
				expect(matched?.workflow).toBe("cronwf");
			}));
});
