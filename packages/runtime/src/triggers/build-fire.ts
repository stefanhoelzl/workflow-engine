import type { WorkflowManifest } from "@workflow-engine/core";
import type { Executor } from "../executor/index.js";
import type {
	InvokeResult,
	TriggerDescriptor,
	ValidationIssue,
} from "../executor/types.js";
import type { Logger } from "../logger.js";
import {
	validate as defaultValidate,
	validateOutput as defaultValidateOutput,
} from "./validator.js";

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
//      workflow, descriptor, validatedInput, bundleSource)`.
//   4. On `{ok: true, output}`: validates `output` against
//      `descriptor.outputSchema` (Ajv). On mismatch — the handler returned
//      a value that violates its own contract — resolves to `{ok: false,
//      error: {message}}` **without** `issues`, so the HTTP backend's
//      `no-issues → 500` rule correctly routes this as a server bug
//      (client did nothing wrong). Structured per-field issues are
//      preserved for observability via the optional `logger` passed in.
//
// The helper is intentionally non-generic. Kind-specific types don't
// propagate meaningfully through the registry's descriptor iteration; the
// SDK's author-facing Zod + `z.infer` types cover ergonomics at the point
// that matters. Fire is uniformly `(unknown) => Promise<InvokeResult<unknown>>`.

type Validate = typeof defaultValidate;
type ValidateOutput = typeof defaultValidateOutput;

// Cap the inlined per-field detail on output-validation failures so the
// error.message stays log-friendly. Structured issues still flow fully to
// `logger.warn(...)` and (eventually) the event bus.
const ISSUE_SUMMARY_LIMIT = 3;

function summariseIssues(issues: readonly ValidationIssue[]): string {
	if (issues.length === 0) {
		return "schema mismatch";
	}
	const parts = issues.slice(0, ISSUE_SUMMARY_LIMIT).map((i) => {
		const path = i.path.length === 0 ? "/" : `/${i.path.join("/")}`;
		return `${path}: ${i.message}`;
	});
	const extraCount = issues.length - ISSUE_SUMMARY_LIMIT;
	const extra = extraCount > 0 ? ` (+${extraCount} more)` : "";
	return parts.join("; ") + extra;
}

// biome-ignore lint/complexity/useMaxParams: bound closure needs executor + identity + validation + observability
function buildFire(
	executor: Executor,
	tenant: string,
	workflow: WorkflowManifest,
	descriptor: TriggerDescriptor,
	bundleSource: string,
	logger?: Logger,
	validate: Validate = defaultValidate,
	validateOutput: ValidateOutput = defaultValidateOutput,
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
		return executor
			.invoke(tenant, workflow, descriptor, v.input, bundleSource)
			.then((result) => {
				if (!result.ok) {
					return result;
				}
				const vout = validateOutput(descriptor, result.output);
				if (vout.ok) {
					return result;
				}
				// Output-validation failure is a handler contract violation
				// (server bug). Surface structured issues to logs so
				// dashboards/archives retain per-field detail, but DO NOT
				// attach `issues` to the error envelope — the HTTP backend
				// maps "no issues" to 500, which is the correct response for
				// a server-side contract failure. The client did nothing
				// wrong; a 422 would mislead.
				logger?.warn("trigger.output-validation-failed", {
					tenant,
					workflow: workflow.name,
					trigger: descriptor.name,
					kind: descriptor.kind,
					issues: vout.issues,
				});
				return {
					ok: false as const,
					error: {
						message: `output validation: ${summariseIssues(vout.issues)}`,
					},
				};
			});
	};
}

export { buildFire };
