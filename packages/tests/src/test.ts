import { test as vitestTest } from "vitest";
import { getActiveContext } from "./describe.js";
import { createScenario } from "./scenario.js";
import type { Scenario } from "./types.js";

function test(name: string, body: (s: Scenario) => Scenario): void {
	vitestTest(name, async () => {
		const ctx = getActiveContext();
		const child = ctx.getChild();
		// Auto-mark per test so `state.logs` only includes lines emitted
		// during this test's execution. Sibling tests in the same describe
		// share the runtime child, so without the marker `state.logs` would
		// leak prior tests' lines into the assertion (most importantly, a
		// prior test's sealed-secret plaintext into a later assertNotPresent).
		const logMarker = child.logStream.mark();
		const scenario = createScenario();
		body(scenario);
		await scenario.run({
			child,
			buildEnv: ctx.getBuildEnv(),
			logMarker,
		});
	});
}

export { test };
