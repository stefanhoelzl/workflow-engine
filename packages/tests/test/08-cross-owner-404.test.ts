import { describe, expect, test } from "@workflow-engine/tests";

// Test #8 — cross-owner 404 enumeration semantics. A workflow is uploaded
// under owner `acme`. Two non-members (`bob`) and one member (`alice`) probe
// the same `(acme, e2e)` namespace via both the API (`Authorization: User`
// header) and the UI dashboard (sealed `session` cookie). Non-members must
// receive an opaque 404 — indistinguishable from "owner does not exist" — so
// no information about which owners are populated leaks. Members see the
// real workflow listing.
//
// AUTH_ALLOW is overridden for this describe block to give the default
// upload user (`dev`) acme membership; alice keeps acme membership; bob is
// scoped only to its own org. Same SECURITY.md §4 isMember/404 invariant
// either way — the upload user is just plumbing for getting a workflow into
// acme without adding `user` to WorkflowOpts.

describe("cross-owner enumeration returns 404", {
	env: { AUTH_ALLOW: "local:dev:acme,local:alice:acme,local:bob" },
}, () => {
	test("bob sees 404 for acme; alice sees 200", (s) =>
		s
			.workflow(
				"scoped",
				`
import {httpTrigger, z} from "@workflow-engine/sdk";

export const ping = httpTrigger({
	request: { body: z.object({}) },
	handler: async () => ({status: 200, body: "pong"}),
});
`,
				{ owner: "acme", repo: "e2e" },
			)
			// `/api/workflows/:owner/public-key` is the real `/api/*` surface
			// behind `requireOwnerMember` — non-members get an opaque 404, members
			// get a 200 with the X25519 pubkey JSON. Substitute for the proposal's
			// `/api/workflows/acme` listing-style probe (no such GET route exists
			// in v1; CLAUDE.md's example was stale).
			.fetch("/api/workflows/acme/public-key", {
				auth: { user: "bob", via: "api-header" },
				label: "bobApi",
			})
			.fetch("/dashboard/acme", {
				auth: { user: "bob", via: "cookie" },
				label: "bobDash",
			})
			.fetch("/api/workflows/acme/public-key", {
				auth: { user: "alice", via: "api-header" },
				label: "aliceApi",
			})
			.expect((state) => {
				expect(state.fetches.byLabel("bobApi").status).toBe(404);
				expect(state.fetches.byLabel("bobDash").status).toBe(404);
				expect(state.fetches.byLabel("aliceApi").status).toBe(200);
			}));
});
