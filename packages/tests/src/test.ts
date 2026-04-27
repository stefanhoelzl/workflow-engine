import { inject, test as vitestTest } from "vitest";
import { getActiveContext } from "./describe.js";
import type { Marker } from "./log-stream.js";
import { createMockClient } from "./mocks/client.js";
import "./mocks/provided.js";
import { createScenario } from "./scenario.js";
import type { HttpCapture, Scenario } from "./types.js";

function test(name: string, body: (s: Scenario) => Scenario): void {
	vitestTest(name, async () => {
		const ctx = getActiveContext();
		const mocks = inject("mocks");
		const httpClient = createMockClient<HttpCapture>({
			adminUrl: mocks.echo.adminUrl,
		});
		// Auto-mark per test so `state.logs` only includes lines emitted
		// during this test's execution. After a respawn the LogStream is a
		// fresh buffer, so `resetLogMarker` re-marks at the new origin.
		let marker: Marker = ctx.getChild().logStream.mark();
		const scenario = createScenario();
		body(scenario);
		await scenario.run({
			getChild: () => ctx.getChild(),
			respawn: () => ctx.respawnChild(),
			buildEnv: ctx.getBuildEnv(),
			httpClient,
			getLogMarker: () => marker,
			resetLogMarker: () => {
				marker = ctx.getChild().logStream.mark();
			},
		});
	});
}

export { test };
