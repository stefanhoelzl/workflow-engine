// Main-thread helper that compiles a WorkflowManifest's per-action input AND
// output schemas into Ajv `standaloneCode` sources, producing the
// host-call-action plugin's `Config` payload. Runs wherever sandbox-store
// constructs a sandbox — Ajv is imported here so the plugin file itself stays
// Ajv-free and its worker bundle tree-shakes to a handful of KB.

import type { WorkflowManifest } from "@workflow-engine/core";
import Ajv2020 from "ajv/dist/2020.js";
import standaloneCodeMod from "ajv/dist/standalone/index.js";
import type { Config as HostCallActionConfig } from "./plugins/host-call-action.js";

// Ajv's standalone module is CJS-shaped; resolve the default export
// with the same idiom used elsewhere in the codebase for Ajv interop.
const standaloneCode = ((standaloneCodeMod as { default?: unknown }).default ??
	standaloneCodeMod) as (ajv: Ajv2020.default, refsOrFunc: unknown) => string;

/**
 * Compile the action-input and action-output validators for a workflow's
 * manifest into `standaloneCode` source strings, one per action per direction.
 * The resulting record is safe to JSON-serialise across the postMessage
 * boundary (it's just strings) and is consumed by the host-call-action
 * plugin's `worker()` via `new Function(src)` at sandbox boot.
 *
 * Runs once per sandbox construction (keyed by `(tenant, sha)` in
 * `SandboxStore`); no recompilation between runs.
 */
function compileActionValidators(
	manifest: WorkflowManifest,
): HostCallActionConfig {
	const ajv = new Ajv2020.default({
		allErrors: true,
		strict: false,
		code: { source: true, esm: false },
	});
	const inputValidatorSources: Record<string, string> = {};
	const outputValidatorSources: Record<string, string> = {};
	for (const action of manifest.actions) {
		// biome-ignore lint/suspicious/noExplicitAny: Ajv's compile signature takes a broad JSON-Schema shape
		const inputValidator = ajv.compile(action.input as any);
		inputValidatorSources[action.name] = standaloneCode(ajv, inputValidator);
		// biome-ignore lint/suspicious/noExplicitAny: Ajv's compile signature takes a broad JSON-Schema shape
		const outputValidator = ajv.compile(action.output as any);
		outputValidatorSources[action.name] = standaloneCode(ajv, outputValidator);
	}
	return { inputValidatorSources, outputValidatorSources };
}

export { compileActionValidators };
