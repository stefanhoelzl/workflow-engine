import { describe, expect, test } from "@workflow-engine/tests";
import { getMocks } from "@workflow-engine/tests/mocks";

// Test #17 — SSRF guard. The workflow handler tries to fetch the
// suite-shared HTTP echo mock at its loopback URL. hardenedFetch's
// net-guard rejects the loopback address with `HostBlockedError` before
// the socket ever opens, so the mock never receives the request.
//
// `LOOPBACK_URL` is threaded through `describe.buildEnv` (the same
// path used by test #14 for `GREETING`); `getMocks().echo.urlFor` owns
// the slug-in-path convention so the test never hand-concats it.
const { echo } = getMocks();
const SLUG = "ssrf-loopback";

describe("fetch SSRF guard", {
	buildEnv: { LOOPBACK_URL: echo.urlFor(SLUG, "probe") },
}, () => {
	test("hardenedFetch rejects mock loopback URL", (s) =>
		s
			.workflow(
				"ssrf",
				`
import {defineWorkflow, env, httpTrigger, z} from "@workflow-engine/sdk";

export const workflow = defineWorkflow({
	env: {
		LOOPBACK_URL: env({}),
	},
});

export const probe = httpTrigger({
	body: z.object({}),
	responseBody: z.object({
		blocked: z.boolean(),
		message: z.string().optional(),
	}),
	handler: async () => {
		try {
			const r = await fetch(workflow.env.LOOPBACK_URL);
			return {body: {blocked: false, message: "unexpected status " + r.status}};
		} catch (err) {
			return {body: {blocked: true, message: err instanceof Error ? err.message : String(err)}};
		}
	},
});
`,
			)
			.webhook("probe", { body: {} })
			.expect(async (state) => {
				expect(state.responses).toHaveLength(1);
				const r = state.responses.byIndex(0);
				expect(r).toMatchObject({ status: 200, body: { blocked: true } });
				const captures = await state.http.captures({ slug: SLUG });
				expect(captures).toHaveLength(0);
			}));
});
