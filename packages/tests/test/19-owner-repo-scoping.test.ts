import { describe, expect, test } from "@workflow-engine/tests";

// Test #19 — owner/repo scoping. The same workflow source is uploaded under
// three different `(owner, repo)` tuples; webhooks fire against each tuple
// and each invocation must be attributed to its own tuple. This verifies
// `WorkflowRegistry` is keyed by `(owner, repo)` end-to-end and that
// runtime-stamped event fields (`owner`, `repo`, `workflow`) reflect the URL
// the webhook was fired against — the load-bearing isolation guarantee from
// the security invariants (CLAUDE.md §R-8).
//
// The spawn fixture's AUTH_ALLOW currently scopes `dev` to its own org, so
// all three tuples vary `repo` under owner `dev`. The isolation guarantee
// being asserted (registry keyed by the full tuple) is identical regardless
// of which axis varies.

const SOURCE = `
import {httpTrigger, z} from "@workflow-engine/sdk";

export const ping = httpTrigger({
	body: z.object({}),
	handler: async () => ({status: 200, body: "pong"}),
});
`;

describe("owner/repo scoping", () => {
	test("three tuples isolate workflows and events", (s) =>
		s
			.workflow("scoped", SOURCE, { repo: "alpha" })
			.workflow("scoped", SOURCE, { repo: "beta" })
			.workflow("scoped", SOURCE, { repo: "gamma" })
			.upload()
			.webhook("ping", { repo: "alpha", body: {} })
			.webhook("ping", { repo: "beta", body: {} })
			.webhook("ping", { repo: "gamma", body: {} })
			.waitForEvent({
				kind: "trigger.response",
				trigger: "ping",
				owner: "dev",
				repo: "alpha",
			})
			.waitForEvent({
				kind: "trigger.response",
				trigger: "ping",
				owner: "dev",
				repo: "beta",
			})
			.waitForEvent({
				kind: "trigger.response",
				trigger: "ping",
				owner: "dev",
				repo: "gamma",
			})
			.expect((state) => {
				// state.workflows entries carry {name, sha, owner, repo}.
				expect(state.workflows).toHaveLength(3);
				const tuples = state.workflows
					.map((w) => `${w.owner}/${w.repo}/${w.name}`)
					.sort();
				expect(tuples).toEqual([
					"dev/alpha/scoped",
					"dev/beta/scoped",
					"dev/gamma/scoped",
				]);

				// One upload group per (owner, repo) — the multi-workflow
				// queueing from PR 4 batches by tuple.
				expect(state.uploads).toHaveLength(3);
				const uploadTuples = state.uploads
					.map((u) => `${u.owner}/${u.repo}`)
					.sort();
				expect(uploadTuples).toEqual(["dev/alpha", "dev/beta", "dev/gamma"]);

				// Each webhook produced a 200 response.
				expect(state.responses).toHaveLength(3);
				for (let i = 0; i < state.responses.length; i++) {
					const res = state.responses.byIndex(i);
					if ("error" in res) {
						throw new Error(`webhook errored: ${res.error}`);
					}
					expect(res.status).toBe(200);
					expect(res.body).toBe("pong");
				}

				// Cross-tuple isolation: each tuple sees its own
				// trigger.response and nothing belonging to another tuple.
				for (const repo of ["alpha", "beta", "gamma"]) {
					const responses = state.events.filter(
						(e) =>
							e.kind === "trigger.response" &&
							e.name === "ping" &&
							e.owner === "dev" &&
							e.repo === repo,
					);
					expect(responses).toHaveLength(1);
					const ev = responses[0];
					if (!ev) {
						throw new Error("unreachable");
					}
					expect(ev.workflow).toBe("scoped");
				}

				// No event leaked into a tuple that didn't fire it: every
				// trigger.* event for `ping` belongs to one of the three
				// known tuples.
				const known = new Set(["alpha", "beta", "gamma"]);
				for (const ev of state.events) {
					if (ev.kind.startsWith("trigger.") && ev.name === "ping") {
						expect(ev.owner).toBe("dev");
						expect(known.has(ev.repo as string)).toBe(true);
					}
				}
			}));
});
