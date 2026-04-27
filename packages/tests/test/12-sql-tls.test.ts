import { describe, expect, test } from "@workflow-engine/tests";
import { getMocks } from "@workflow-engine/tests/mocks";

// Test #12 — SQL TLS handshake. The workflow handler calls `executeSql`
// against the embedded-postgres mock with `ssl: {ca, rejectUnauthorized: true}`.
// The mock cluster is configured with a self-signed cert; the matching CA
// PEM is shipped to the workflow as build-time env. A successful query
// proves the handshake completed (verification + cipher) — the query
// itself just round-trips a literal so the assertion stays focused.
//
// `WFE_TEST_DISABLE_SSRF_PROTECTION=true` is required because the mock
// binds loopback (127.0.0.1) and the SQL plugin's net-guard would
// otherwise reject the connection before the handshake.
const { pg } = getMocks();

describe("sql tls handshake", {
	env: { WFE_TEST_DISABLE_SSRF_PROTECTION: "true" },
	buildEnv: { PG_URL: pg.url, PG_CA: pg.ca },
}, () => {
	test("executeSql round-trips a literal over verified TLS", (s) =>
		s
			.workflow(
				"sqltls",
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
	responseBody: z.object({n: z.number()}),
	handler: async () => {
		const r = await executeSql(
			{
				connectionString: workflow.env.PG_URL,
				ssl: {ca: workflow.env.PG_CA, rejectUnauthorized: true},
			},
			"SELECT 1 AS n",
		);
		const row = r.rows[0];
		const n = typeof row?.n === "number" ? row.n : Number(row?.n);
		return {body: {n}};
	},
});
`,
			)
			.webhook("probe", { body: {} })
			.expect((state) => {
				expect(state.responses).toHaveLength(1);
				expect(state.responses.byIndex(0)).toMatchObject({
					status: 200,
					body: { n: 1 },
				});
			}));
});
