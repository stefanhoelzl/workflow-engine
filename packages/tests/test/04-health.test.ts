import { describe, expect, test } from "@workflow-engine/tests";

// Test #4 — `.fetch` smokes the spawned runtime by hitting its health
// endpoint. Verifies the fetch step issues a real HTTP request to
// `child.baseUrl`, captures status/headers/body into `state.fetches`, and
// that the runtime's health surface is reachable immediately after spawn.
//
// Note: the proposal's task description named `/health` returning
// `{eventStore, storage, version}`. The actual runtime exposes `/healthz`
// (and `/livez`, `/readyz`) returning `{status, checks?}` per the
// application/health+json shape — see `packages/runtime/src/health.ts`.
// The intent of the test is unchanged: prove `.fetch` reaches the spawned
// child and records a 200 response.
describe("health endpoint reachable", () => {
	test("readyz returns 200 with all checks passing", (s) =>
		s.fetch("/readyz").expect((state) => {
			expect(state.fetches).toHaveLength(1);
			const got = state.fetches.byIndex(0);
			expect(got.status).toBe(200);
			expect(got.body).toMatchObject({ status: "pass" });
		}));
});
