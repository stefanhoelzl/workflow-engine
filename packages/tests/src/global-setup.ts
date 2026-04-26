import { syncSentinel } from "./fixtures/cache.js";

// vitest globalSetup: invoked once per suite before any worker starts.
// Wipes `packages/tests/.cache/wfe-tests/` if the SDK or core dist
// fingerprint differs from the stored sentinel, so workers never see
// stale cached fixtures built against an older SDK.
async function setup(): Promise<void> {
	await syncSentinel();
}

// vitest's globalSetup contract requires a default export.
// biome-ignore lint/style/noDefaultExport: vitest globalSetup contract
export default setup;
