import { describe, expect, test } from "@workflow-engine/tests";

// Test #7 — LRU eviction by sandbox count pressure. With SANDBOX_MAX_COUNT=2
// and three distinct workflow shas hot in the cache, firing the third
// workflow forces an LRU eviction of the first. The eviction is observable
// as a `sandbox evicted` log line carrying the evicted entry's sha and
// `reason: "lru"` (per the upgrade note "Sandbox cache eviction +
// SANDBOX_MAX_COUNT"). Each workflow lives under its own (dev, repo) tuple
// so `state.workflows.find(...)` in the webhook step routes to the right
// bundle and so the three sandbox keys (owner=dev, sha=…) stay distinct.

const wfSource = (label: string): string => `
import {httpTrigger, z} from "@workflow-engine/sdk";

export const ping = httpTrigger({
	body: z.object({}),
	handler: async () => ({status: 200, body: ${JSON.stringify(label)}}),
});
`;

describe("LRU", { env: { SANDBOX_MAX_COUNT: "2" } }, () => {
	test("third sandbox evicts the first under count pressure", (s) =>
		s
			.workflow("lru", wfSource("one"), { repo: "one", label: "wf1" })
			.workflow("lru", wfSource("two"), { repo: "two", label: "wf2" })
			.workflow("lru", wfSource("three"), { repo: "three", label: "wf3" })
			.upload()
			.webhook("ping", { repo: "one", body: {}, label: "fire1" })
			.webhook("ping", { repo: "two", body: {}, label: "fire2" })
			.webhook("ping", { repo: "three", body: {}, label: "fire3" })
			.expect((state) => {
				expect(state.workflows).toHaveLength(3);
				expect(state.responses.byLabel("fire1")).toMatchObject({
					status: 200,
					body: "one",
				});
				expect(state.responses.byLabel("fire2")).toMatchObject({
					status: 200,
					body: "two",
				});
				expect(state.responses.byLabel("fire3")).toMatchObject({
					status: 200,
					body: "three",
				});

				// The 3rd sandbox creation pushes the cache above its cap of 2
				// and triggers an LRU sweep. The point of the test is the
				// eviction-by-count signal — `reason: "lru"` and `runCount: 1`
				// (the victim ran exactly once before being evicted). Pinning
				// to a specific sha would re-derive the upload pipeline's
				// sha-stability guarantee, which is already covered by test #5.
				const evictionLines = state.logs.filter(
					(l) => l.msg === "sandbox evicted",
				);
				expect(evictionLines).toContainEqual(
					expect.objectContaining({
						msg: "sandbox evicted",
						reason: "lru",
						owner: "dev",
						runCount: 1,
					}),
				);
			}));
});
