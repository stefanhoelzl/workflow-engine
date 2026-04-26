import { describe, expect, test } from "@workflow-engine/tests";

// Test #14 — env round-trip. The workflow's `env({})` binding for `GREETING`
// is resolved at fixture build time from the host process env (which the
// describe-level `buildEnv` injects), embedded in the manifest, and read by
// the http handler at run time as `workflow.env.GREETING`. The webhook fires
// and the response body must contain the originally-injected value.
describe("env round-trip", { buildEnv: { GREETING: "hello-from-cli" } }, () => {
	test("env passed through to http handler response", (s) =>
		s
			.workflow(
				"envwf",
				`
import {defineWorkflow, env, httpTrigger, z} from "@workflow-engine/sdk";

export const workflow = defineWorkflow({
	env: {
		GREETING: env({}),
	},
});

export const ping = httpTrigger({
	body: z.object({}),
	responseBody: z.object({g: z.string()}),
	handler: async () => ({body: {g: workflow.env.GREETING}}),
});
`,
			)
			.webhook("ping", { body: {} })
			.expect((state) => {
				expect(state.responses).toHaveLength(1);
				expect(state.responses.byIndex(0)).toMatchObject({
					status: 200,
					body: { g: "hello-from-cli" },
				});
			}));
});
