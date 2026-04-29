import asyncExitHook from "async-exit-hook";
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
	// embedded-postgres calls AsyncExitHook(gracefulShutdown) at module-load
	// time (dist/index.js:397). async-exit-hook hooks `beforeExit` with
	// code=0 and ultimately calls process.exit(0), clobbering the
	// process.exitCode=1 vitest sets on test failure. The companion `exit`
	// hook invokes the same gracefulShutdown synchronously without the
	// `done` callback (async-exit-hook only passes it on async-eligible
	// events), which throws `TypeError: done is not a function` after
	// vitest exits. No upstream opt-out exists in embedded-postgres.
	// Unhook both `beforeExit` and `exit`; SIGINT/SIGTERM/SIGHUP/SIGBREAK
	// stay registered so a Ctrl+C during a local run still tears down the
	// embedded postgres cluster instead of leaving a zombie.
	asyncExitHook.unhookEvent("beforeExit");
	asyncExitHook.unhookEvent("exit");
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
