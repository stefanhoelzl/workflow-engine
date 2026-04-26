import { test as vitestTest } from "vitest";
import { getActiveContext } from "./describe.js";
import { createScenario } from "./scenario.js";
import type { Scenario } from "./types.js";

function test(name: string, body: (s: Scenario) => Scenario): void {
	vitestTest(name, async () => {
		const ctx = getActiveContext();
		const scenario = createScenario();
		body(scenario);
		await scenario.run({
			child: ctx.getChild(),
			buildEnv: ctx.getBuildEnv(),
		});
	});
}

export { test };
