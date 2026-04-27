import type { TestProject } from "vitest/node";
import { syncSentinel } from "./fixtures/cache.js";
import { type MockSuite, startMockSuite } from "./mocks/index.js";
import "./mocks/provided.js";

let suite: MockSuite | null = null;

// vitest globalSetup: invoked once per suite before any worker starts.
// - Wipes `packages/tests/.cache/wfe-tests/` if the SDK or core dist
//   fingerprint differs from the stored sentinel.
// - Boots the suite-shared mock infrastructure (HTTP echo + admin server)
//   and provides `{echo: {url, adminUrl}}` so workers can `inject("mocks")`.
async function setup(project: TestProject): Promise<() => Promise<void>> {
	await syncSentinel();
	suite = await startMockSuite();
	project.provide("mocks", suite.provided);
	return async () => {
		if (suite) {
			await suite.stop();
			suite = null;
		}
	};
}

// vitest's globalSetup contract requires a default export.
// biome-ignore lint/style/noDefaultExport: vitest globalSetup contract
export default setup;
