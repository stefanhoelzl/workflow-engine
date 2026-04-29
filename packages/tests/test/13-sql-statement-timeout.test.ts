import { describe, expect, test } from "@workflow-engine/tests";
import { getMocks } from "@workflow-engine/tests/mocks";

// Test #13 — SQL statement_timeout. `executeSql` passes `timeoutMs` through
// to porsager/postgres as the `statement_timeout` Postgres startup
// parameter. A `pg_sleep(1)` against a 100 ms timeout must trigger a
// server-side cancellation; the driver re-throws as a `SqlError` whose
// `kind` is `"timeout"` and `code` is `"57014"`. (Verbatim driver messages
// are no longer forwarded across the host/sandbox bridge per the
// 2026-04-29 boundary-opacity change — assert on structured fields.)
const { pg } = getMocks();

describe("sql statement timeout", {
	env: { WFE_TEST_DISABLE_SSRF_PROTECTION: "true" },
	buildEnv: { PG_URL: pg.url, PG_CA: pg.ca },
}, () => {
	test("statement_timeout cancels long query", (s) =>
		s
			.workflow(
				"sqltimeout",
				`
import {defineWorkflow, env, executeSql, httpTrigger, z} from "@workflow-engine/sdk";

export const workflow = defineWorkflow({
	env: {
		PG_URL: env({}),
		PG_CA: env({}),
	},
});

export const probe = httpTrigger({
	request: { body: z.object({}) },
	response: {
		body: z.object({
			ok: z.boolean(),
			kind: z.string().optional(),
			code: z.string().optional(),
		}),
	},
	handler: async () => {
		try {
			await executeSql(
				{
					connectionString: workflow.env.PG_URL,
					ssl: {ca: workflow.env.PG_CA, rejectUnauthorized: true},
				},
				"SELECT pg_sleep(1)",
				[],
				{timeoutMs: 100},
			);
			return {body: {ok: true}};
		} catch (err) {
			const e = err as { kind?: string; code?: string };
			return {body: {ok: false, kind: e?.kind, code: e?.code}};
		}
	},
});
`,
			)
			.webhook("probe", { body: {} })
			.expect((state) => {
				expect(state.responses).toHaveLength(1);
				const r = state.responses.byIndex(0) as {
					status: number;
					body: { ok: boolean; kind?: string; code?: string };
				};
				expect(r.status).toBe(200);
				expect(r.body.ok).toBe(false);
				expect(r.body.kind).toBe("timeout");
				expect(r.body.code).toBe("57014");
			}));
});
