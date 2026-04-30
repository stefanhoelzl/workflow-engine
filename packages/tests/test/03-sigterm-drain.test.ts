import { describe, expect, test } from "@workflow-engine/tests";

// Test #3 — SIGTERM graceful drain.
//
// Under the new event-store-ducklake architecture, in-flight invocations
// live only in the runtime's in-memory accumulator. SIGTERM triggers a
// drain that synthesises `trigger.error{kind:"shutdown"}` for any
// invocation that has not yet reached a natural terminal, commits each to
// the DuckLake catalog, and exits.
//
// This test fires a long-running webhook handler (sleep 30s) and SIGTERMs
// while the handler is still sleeping. `sandboxStore.dispose()` drains
// for at most `DRAIN_TIMEOUT_MS` (10 s) waiting for active sandboxes to
// finish naturally; on timeout it tears them down. EventStore then
// synthesises `trigger.error{kind:"shutdown"}` for any invocation still
// in its accumulator. After respawn, the framework reads the Parquet
// archive and asserts that the invocation has the synthetic shutdown
// terminal — proving the in-flight invocation surfaced in the durable
// archive rather than vanishing silently.

describe("sigterm graceful drain", () => {
	test("in-flight invocation drains to a shutdown synthetic terminal", (s) =>
		s
			.workflow(
				"slow",
				`
import {httpTrigger, z} from "@workflow-engine/sdk";

export const slow = httpTrigger({
	request: { body: z.object({}) },
	handler: async () => {
		// Sleep longer than sandbox-store's DRAIN_TIMEOUT_MS (10 s) so the
		// handler does NOT complete naturally during shutdown — the
		// runtime is forced to terminate the sandbox and EventStore
		// synthesises the shutdown terminal.
		await new Promise((r) => setTimeout(r, 30000));
		return {body: {ok: true}};
	},
});
`,
			)
			.webhook("slow", { body: {}, label: "fire1" })
			// Wait for the executor's lifecycle log line that fires exactly
			// when EventStore.record(trigger.request) returns. Under the
			// new architecture in-flight events live only in RAM (not the
			// catalog), so logs are the only externally observable
			// "invocation has started" signal.
			.waitForLog({ msg: "invocation.started", trigger: "slow" })
			.sigterm({ restart: true })
			.waitForEvent({
				label: "fire1",
				archived: true,
				kind: "trigger.error",
			})
			.expect((state) => {
				const successes = state.events.filter(
					(e) => e.kind === "trigger.response" && e.name === "slow",
				);
				expect(successes).toHaveLength(0);
				const terminals = state.events.filter(
					(e) => e.kind === "trigger.error" && e.name === "slow",
				);
				expect(terminals).toHaveLength(1);
				// `error` is persisted as a JSON-encoded string in the Parquet
				// column; parse before asserting on the synthetic-shutdown shape.
				const evt = terminals[0] as { error?: unknown } | undefined;
				const raw = evt?.error;
				const parsed: { kind?: string } =
					typeof raw === "string"
						? (JSON.parse(raw) as { kind?: string })
						: ((raw ?? {}) as { kind?: string });
				expect(parsed.kind).toBe("shutdown");
			}));
});
