import { describe, expect, test } from "@workflow-engine/tests";
import { getMocks } from "@workflow-engine/tests/mocks";

// Test #13 — SQL statement_timeout. `executeSql` passes `timeoutMs` through
// to porsager/postgres as the `statement_timeout` Postgres startup
// parameter. A `pg_sleep(1)` against a 100 ms timeout must trigger a
// server-side cancellation; the driver re-throws as a `SqlError` whose
// message includes either "statement timeout" (libpq wording) or
// "canceling" (Postgres wording).
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
	body: z.object({}),
	responseBody: z.object({
		ok: z.boolean(),
		message: z.string(),
	}),
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
			return {body: {ok: true, message: "no error"}};
		} catch (err) {
			return {body: {ok: false, message: err instanceof Error ? err.message : String(err)}};
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
					body: { ok: boolean; message: string };
				};
				expect(r.status).toBe(200);
				expect(r.body.ok).toBe(false);
				expect(r.body.message).toMatch(/statement timeout|canceling/i);
			}));
});
