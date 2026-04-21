import type { WorkflowManifest } from "@workflow-engine/core";
import type { Executor } from "../executor/index.js";
import type { InvokeResult, TriggerDescriptor } from "../executor/types.js";
import { validate as defaultValidate } from "./validator.js";

// ---------------------------------------------------------------------------
// buildFire — construct the `fire(input)` closure for one TriggerEntry.
// ---------------------------------------------------------------------------
//
// Backends receive `TriggerEntry { descriptor, fire }`. Calling `fire(input)`:
//   1. Validates `input` against `descriptor.inputSchema` (Ajv, shared
//      `validate()` helper).
//   2. On validation failure: resolves to `{ok: false, error: {message,
//      issues}}` without dispatching through the executor.
//   3. On validation success: dispatches via `executor.invoke(tenant,
//      workflow, descriptor, validatedInput, bundleSource)` and returns
//      its result.
//
// The helper is intentionally non-generic. Kind-specific types don't
// propagate meaningfully through the registry's descriptor iteration; the
// SDK's author-facing Zod + `z.infer` types cover ergonomics at the point
// that matters. Fire is uniformly `(unknown) => Promise<InvokeResult<unknown>>`.

type Validate = typeof defaultValidate;

// biome-ignore lint/complexity/useMaxParams: bound closure needs all six independent pieces (executor + identity + validation)
function buildFire(
	executor: Executor,
	tenant: string,
	workflow: WorkflowManifest,
	descriptor: TriggerDescriptor,
	bundleSource: string,
	validate: Validate = defaultValidate,
): (input: unknown) => Promise<InvokeResult<unknown>> {
	return (input) => {
		const v = validate(descriptor, input);
		if (!v.ok) {
			return Promise.resolve({
				ok: false as const,
				error: {
					message: "payload_validation_failed",
					issues: v.issues,
				},
			});
		}
		return executor.invoke(tenant, workflow, descriptor, v.input, bundleSource);
	};
}

export { buildFire };
