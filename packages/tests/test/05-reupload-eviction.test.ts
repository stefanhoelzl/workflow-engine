import { describe, expect, test } from "@workflow-engine/tests";

// Test #5 — re-upload + sandbox eviction. The same workflow name is uploaded
// twice with different bodies (different sha). With SANDBOX_MAX_COUNT=1 the
// second upload's first invocation forces the sandbox-store LRU sweep to
// evict v1's entry, which logs `sandbox evicted` carrying v1's sha. The test
// pulls v1's sha out of the labelled first upload and asserts the eviction
// line references it.

describe("re-upload + sandbox eviction", {
	env: { SANDBOX_MAX_COUNT: "1" },
}, () => {
	test("v2 upload evicts v1 sandbox under count pressure", (s) =>
		s
			.workflow(
				"reup",
				`
import {httpTrigger, z} from "@workflow-engine/sdk";

export const ping = httpTrigger({
	body: z.object({}),
	handler: async () => ({status: 200, body: "v1"}),
});
`,
				{ label: "v1wf" },
			)
			.upload({ label: "v1up" })
			.webhook("ping", { body: {}, label: "v1res" })
			.workflow(
				"reup",
				`
import {httpTrigger, z} from "@workflow-engine/sdk";

export const ping = httpTrigger({
	body: z.object({}),
	handler: async () => ({status: 200, body: "v2"}),
});
`,
				{ label: "v2wf" },
			)
			.upload({ label: "v2up" })
			.webhook("ping", { body: {}, label: "v2res" })
			.expect((state) => {
				expect(state.uploads).toHaveLength(2);
				const v1 = state.uploads.byLabel("v1up");
				const v2 = state.uploads.byLabel("v2up");
				expect(v1.workflows).toHaveLength(1);
				expect(v2.workflows).toHaveLength(1);
				const v1sha = v1.workflows[0]?.sha ?? "";
				const v2sha = v2.workflows[0]?.sha ?? "";
				expect(v1sha).toMatch(/^[a-f0-9]{64}$/);
				expect(v2sha).toMatch(/^[a-f0-9]{64}$/);
				expect(v1sha).not.toBe(v2sha);

				const v1Response = state.responses.byLabel("v1res");
				expect(v1Response).toMatchObject({ body: "v1" });

				const v2Response = state.responses.byLabel("v2res");
				expect(v2Response).toMatchObject({ body: "v2" });

				const evictionLines = state.logs.filter(
					(l) => l.msg === "sandbox evicted",
				);
				expect(evictionLines).toContainEqual(
					expect.objectContaining({
						msg: "sandbox evicted",
						sha: v1sha,
						reason: "lru",
					}),
				);
			}));
});
