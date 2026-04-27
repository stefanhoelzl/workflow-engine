// Main-thread helper that extracts a WorkflowManifest's per-action input/
// output JSON Schemas into the `host-call-action` plugin's Config payload.
// The payload is a pair of `Record<actionName, JSONSchema>` maps; the plugin
// rehydrates each schema into a Zod validator at worker() boot via
// `z.fromJSONSchema()`. No compilation, no source-string emission — JSON
// Schema crosses the main→worker boundary unchanged.

import type { WorkflowManifest } from "@workflow-engine/core";
import type { Config as HostCallActionConfig } from "./plugins/host-call-action.js";

/**
 * Build the `host-call-action` plugin's `Config` from a workflow manifest:
 * one input/output JSON Schema per declared action. The resulting record is
 * JSON-serialisable across the postMessage boundary — Zod schema objects are
 * NOT, which is why rehydration happens in the worker after structured-clone
 * delivery.
 *
 * Runs once per sandbox construction (keyed by `(owner, sha)` in
 * `SandboxStore`); the plugin's `worker()` rehydrates once at boot and
 * reuses the resulting Zod schemas for the sandbox's lifetime.
 */
function compileActionValidators(
	manifest: WorkflowManifest,
): HostCallActionConfig {
	const inputSchemas: Record<string, Record<string, unknown>> = {};
	const outputSchemas: Record<string, Record<string, unknown>> = {};
	for (const action of manifest.actions) {
		inputSchemas[action.name] = action.input as Record<string, unknown>;
		outputSchemas[action.name] = action.output as Record<string, unknown>;
	}
	return { inputSchemas, outputSchemas };
}

export { compileActionValidators };
