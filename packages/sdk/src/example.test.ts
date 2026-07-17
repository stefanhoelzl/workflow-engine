import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildWorkflows } from "./cli/build-workflows.js";

// The SDK ships `example.ts` (the canonical full-surface authoring reference) in
// its npm tarball. This test is the CI gate that keeps it true: it bundle-
// validates the example (typecheck + Rolldown) against the real SDK types on
// every run, and NEVER uploads it. Because bundling does not execute handlers,
// the gate covers infra-only trigger kinds (`imapTrigger`, `wsTrigger`) that
// cannot run in local dev — they are validated at compile time here.
const sdkDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Placeholder values for the example's `env({secret: true})` fields, mirroring
// the placeholder env the `workflows` package uses for its own bundle build.
const PLACEHOLDER_ENV = {
	WEBHOOK_TOKEN: "placeholder",
	IMAP_USER: "placeholder",
	IMAP_PASSWORD: "placeholder",
} as const;

describe("example.ts bundle validation", () => {
	it("typechecks and bundles against the real SDK surface (no upload)", async () => {
		const result = await buildWorkflows({
			cwd: sdkDir,
			workflows: ["./example.ts"],
			env: { ...PLACEHOLDER_ENV },
		});

		// A successful bundle proves every author-facing surface in example.ts —
		// including `imapTrigger` and `wsTrigger` — compiles against the current
		// SDK types with no mail server or WebSocket client present. A broken
		// example (e.g. a `.optional()` field) throws here and fails the gate.
		expect(result.files.has("example.js")).toBe(true);
		expect(result.manifest.workflows).toHaveLength(1);
	});
});
