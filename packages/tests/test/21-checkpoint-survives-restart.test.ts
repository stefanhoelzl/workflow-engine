import { describe, expect, test } from "@workflow-engine/tests";

// Test — DuckLake CHECKPOINT persists durably across restart.
//
// EventStore's CHECKPOINT flushes inlined-row data from the catalog file
// into Parquet files under `<persistence>/events/main/events/...`. After a
// graceful restart, the events should still be queryable — proving the
// flush is durable and not just an in-memory operation. We force frequent
// CHECKPOINTs by setting `EVENT_STORE_CHECKPOINT_MAX_INLINED_ROWS=1` so
// every committed invocation triggers compaction.

describe("checkpoint survives restart", {
	env: { EVENT_STORE_CHECKPOINT_MAX_INLINED_ROWS: "1" },
}, () => {
	test("invocations committed across multiple checkpoints are queryable after respawn", (s) =>
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
			.webhook("echo", { body: {}, label: "a" })
			.waitForEvent({
				label: "a",
				archived: true,
				kind: "trigger.response",
			})
			.webhook("echo", { body: {}, label: "b" })
			.waitForEvent({
				label: "b",
				archived: true,
				kind: "trigger.response",
			})
			.webhook("echo", { body: {}, label: "c" })
			.waitForEvent({
				label: "c",
				archived: true,
				kind: "trigger.response",
			})
			.sigterm({ restart: true })
			.waitForEvent({
				label: "c",
				archived: true,
				kind: "trigger.response",
			})
			.expect((state) => {
				const responses = state.events.filter(
					(e) => e.kind === "trigger.response" && e.name === "echo",
				);
				expect(responses.length).toBeGreaterThanOrEqual(3);
			}));
});
