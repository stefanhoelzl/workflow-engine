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
				if ("error" in res) {
					throw new Error(`webhook errored: ${res.error}`);
				}
				expect(res.status).toBe(201);
				expect(res.headers.get("x-custom-resp")).toBe("from-handler");
				expect(res.body).toEqual({
					body: { greet: "hi" },
					headerVal: "header-value",
					query: { q: "qval", k: "kval" },
				});
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
				const res = state.responses.byIndex(0);
				if ("error" in res) {
					throw new Error(`webhook errored: ${res.error}`);
				}
				expect(res.status).toBe(422);
				expect(res.body).toMatchObject({
					error: "payload_validation_failed",
				});
			}));
});
