import { defineConfig } from "vitest/config";
import { sandboxPlugins } from "../../../sandbox/src/vite/sandbox-plugins.js";
import { sandboxPolyfills } from "../../src/web-platform/vite-plugin.js";
import { wptPreamble } from "./harness/preamble/vite-plugin.js";
import { WptReporter } from "./harness/wpt-reporter.js";

// Separate vitest config for the WPT suite. The suite is long-running
// (1–3 min for the full MCA subset) and runs WPT test files inside the
// sandbox, which is too heavy for the default `pnpm test` local loop.
//
// Parallelism is OWNED by the runner itself (top-level-await + limitedAll
// with WPT_CONCURRENCY = max(4, cpus × 2)), so vitest's own pool cap is
// set conservatively — each test file does its own fan-out.

const FIVE_MINUTES_MS = 5 * 60_000;
const ONE_MINUTE_MS = 60_000;

export default defineConfig({
	plugins: [wptPreamble(), sandboxPlugins(), sandboxPolyfills()],
	test: {
		include: ["packages/sandbox-stdlib/test/wpt/wpt.test.ts"],
		testTimeout: FIVE_MINUTES_MS,
		hookTimeout: ONE_MINUTE_MS,
		reporters: [new WptReporter()],
	},
});
