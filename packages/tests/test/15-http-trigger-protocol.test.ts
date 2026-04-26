import { describe, expect, test } from "@workflow-engine/tests";

// Test #15 — httpTrigger protocol adapter. Verifies the `.webhook` chain step
// serializes body/headers/query into the runtime request, the handler observes
// them through `HttpTriggerPayload` (body + headers + url for query), and the
// response status/headers/body the handler returns flow back into
// `state.responses`. Negative path: a body that doesn't match the trigger's
// `body` zod schema yields a 422 from the runtime, captured the same way.

describe("httpTrigger protocol adapter", () => {
	test("echoes body/headers/query and returns custom status + headers", (s) =>
		s
			.workflow(
				"echo",
				`
import {httpTrigger, z} from "@workflow-engine/sdk";

export const echo = httpTrigger({
	body: z.object({greet: z.string()}),
	responseBody: z.object({
		body: z.unknown(),
		headerVal: z.string().nullable(),
		query: z.record(z.string(), z.string()),
	}),
	handler: async (payload) => {
		const parsed = new URL(payload.url);
		const params = new URLSearchParams(parsed.search);
		const query: Record<string, string> = {};
		params.forEach((v, k) => {
			query[k] = v;
		});
		return {
			status: 201,
			headers: {"x-custom-resp": "from-handler"},
			body: {
				body: payload.body,
				headerVal: payload.headers["x-test-in"] ?? null,
				query,
			},
		};
	},
});
`,
			)
			.webhook("echo", {
				body: { greet: "hi" },
				headers: { "x-test-in": "header-value" },
				query: { q: "qval", k: "kval" },
			})
			.expect((state) => {
				expect(state.responses).toHaveLength(1);
				const res = state.responses.byIndex(0);
				expect(res).toMatchObject({
					status: 201,
					body: {
						body: { greet: "hi" },
						headerVal: "header-value",
						query: { q: "qval", k: "kval" },
					},
				});
				expect("headers" in res && res.headers.get("x-custom-resp")).toBe(
					"from-handler",
				);
			}));

	test("schema mismatch on body returns 422 with issues", (s) =>
		s
			.workflow(
				"strict",
				`
import {httpTrigger, z} from "@workflow-engine/sdk";

export const strict = httpTrigger({
	body: z.object({greet: z.string()}),
	handler: async () => ({status: 200, body: "ok"}),
});
`,
			)
			.webhook("strict", { body: { greet: 123 } })
			.expect((state) => {
				expect(state.responses).toHaveLength(1);
				expect(state.responses.byIndex(0)).toMatchObject({
					status: 422,
					body: { error: "payload_validation_failed" },
				});
			}));
});
