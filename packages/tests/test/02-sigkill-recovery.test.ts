import { describe, expect, test } from "@workflow-engine/tests";

// Test #2 — SIGKILL crash recovery. A workflow's httpTrigger handler sleeps
// 5s then throws (the throw is a test-bug detector: if the sleep ever
// returned naturally inside the test's hard cap, the assertion below would
// see a `trigger.error` with a non-engine_crashed message, exposing the
// regression). The chain fires the trigger fire-and-forget, waits for the
// pending event to land on disk, then SIGKILLs the runtime and respawns
// against the SAME persistence dir + secrets key. On respawn the recovery
// sweep observes the orphaned pending file, replays its events, and emits
// a synthetic `trigger.error` carrying `error.kind: "engine_crashed"`. The
// test asserts that exact synthetic terminal lands in archive against the
// labeled invocation id.

describe("sigkill crash recovery", () => {
	test("orphaned pending invocation respawns to engine_crashed", (s) =>
		s
			.workflow(
				"slow",
				`
import {httpTrigger, z} from "@workflow-engine/sdk";

export const slow = httpTrigger({
	body: z.object({}),
	handler: async () => {
		await new Promise((r) => setTimeout(r, 5000));
		throw new Error("test-bug: sleep returned naturally");
	},
});
`,
			)
			.webhook("slow", { body: {}, label: "fire1" })
			.waitForEvent({ label: "fire1", archived: false })
			.sigkill({ restart: true })
			.waitForEvent({ label: "fire1", archived: true, kind: "trigger.error" })
			.expect((state) => {
				const crashed = state.events.filter(
					(e) =>
						e.kind === "trigger.error" &&
						(e.error as { kind?: string } | undefined)?.kind ===
							"engine_crashed",
				);
				expect(crashed).toHaveLength(1);
				const evt = crashed[0] as
					| { error: { kind: string; message: string } }
					| undefined;
				expect(evt?.error.message).toMatch(/engine crashed/);
			}));
});
