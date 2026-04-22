import { defineConfig } from "vitest/config";
import { sandboxPlugins } from "./packages/sandbox/src/vite/sandbox-plugins.js";
import { wptPreamble } from "./packages/sandbox-stdlib/test/wpt/harness/preamble/vite-plugin.js";

export default defineConfig({
	plugins: [wptPreamble(), sandboxPlugins()],
	test: {
		include: [
			"packages/*/src/**/*.{test,spec}.ts",
			// Harness unit tests that verify the WPT runner's match/specificity/
			// limited-all helpers. Fast and deterministic, safe to run in the
			// default pnpm test. The heavy WPT suite itself (wpt.test.ts) is
			// excluded below and runs only via pnpm test:wpt.
			"packages/sandbox-stdlib/test/wpt/harness/**/*.{test,spec}.ts",
		],
		exclude: [
			"**/node_modules/**",
			"packages/sandbox-stdlib/test/wpt/wpt.test.ts",
		],
	},
});
