import { describe, expect, test } from "@workflow-engine/tests";

// Test #3 — SIGTERM graceful drain. A workflow's manualTrigger handler
// sleeps 500ms and returns a payload. The chain fires the trigger
// fire-and-forget, awaits the pending event landing on disk, then sends
// SIGTERM with restart. The runtime's shutdown handler awaits in-flight
// invocations via Promise.allSettled and emits `shutdown.complete` as its
// last log line; the framework uses that line as the sync signal. After
// respawn, the recovery sweep observes the now-archived terminal and the
// chain asserts that the archived event is `trigger.response` with the
// handler's success output AND no `engine_crashed` synthetic terminal was
// emitted.

describe("sigterm graceful drain", () => {
	test("in-flight invocation drains to a successful archive", (s) =>
		s
			.workflow(
				"slow",
				`
import {httpTrigger, z} from "@workflow-engine/sdk";

export const slow = httpTrigger({
	request: { body: z.object({}) },
	handler: async () => {
		await new Promise((r) => setTimeout(r, 500));
		return {body: {ok: true}};
	},
});
`,
			)
			.webhook("slow", { body: {}, label: "fire1" })
			.waitForEvent({ label: "fire1", archived: false })
			.sigterm({ restart: true })
			.waitForEvent({
				label: "fire1",
				archived: true,
				kind: "trigger.response",
			})
			.expect((state) => {
				const crashed = state.events.filter(
					(e) =>
						e.kind === "trigger.error" &&
						(e.error as { kind?: string } | undefined)?.kind ===
							"engine_crashed",
				);
				expect(crashed).toHaveLength(0);
				const terminals = state.events.filter(
					(e) => e.kind === "trigger.response" && e.name === "slow",
				);
				expect(terminals).toHaveLength(1);
				const evt = terminals[0] as { output?: unknown } | undefined;
				expect(evt?.output).toEqual({ body: { ok: true } });
			}));
});
