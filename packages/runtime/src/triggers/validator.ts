import type { z } from "@workflow-engine/core";
import type { TriggerDescriptor, ValidationIssue } from "../executor/types.js";

type ValidateResult<T = unknown> =
	| { readonly ok: true; readonly input: T }
	| { readonly ok: false; readonly issues: ValidationIssue[] };

type ValidateOutputResult<T = unknown> =
	| { readonly ok: true; readonly output: T }
	| { readonly ok: false; readonly issues: ValidationIssue[] };

/**
 * Map raw `ZodIssue[]` into the engine-agnostic `ValidationIssue[]` shape
 * (path-of-segments + human-readable message). Hoisted so the host-call-action
 * plugin reuses the same mapping for action-level validation failures.
 */
function zodIssuesToValidationIssues(
	issues: readonly z.core.$ZodIssue[],
): ValidationIssue[] {
	return issues.map((issue) => ({
		path: [...issue.path] as (string | number)[],
		message: issue.message,
	}));
}

function structuredCloneJson<T>(value: T): T {
	if (value === undefined) {
		return value;
	}
	try {
		return JSON.parse(JSON.stringify(value)) as T;
	} catch {
		return value;
	}
}

/**
 * Validate a raw trigger input against a descriptor's pre-rehydrated input
 * Zod schema.
 *
 * Kind-agnostic: every `TriggerSource` calls this before dispatching to the
 * executor. Callers decide the protocol-level response on failure (HTTP 422
 * for HTTP; log-and-drop for cron; etc.). Per-request validator construction
 * is forbidden — `descriptor.zodInputSchema` is rehydrated once at
 * `WorkflowRegistry` registration time and reused.
 */
function validate(
	descriptor: TriggerDescriptor,
	rawInput: unknown,
): ValidateResult<unknown> {
	const copy = structuredCloneJson(rawInput);
	const result = descriptor.zodInputSchema.safeParse(copy);
	if (result.success) {
		return { ok: true, input: result.data };
	}
	return {
		ok: false,
		issues: zodIssuesToValidationIssues(result.error.issues),
	};
}

/**
 * Validate a handler's return value against a descriptor's pre-rehydrated
 * output Zod schema.
 *
 * Runs host-side in `buildFire` after the executor resolves a successful
 * `InvokeResult`. Failure is a server-side contract violation — callers
 * should surface it as HTTP 500 (not a structured 422), and preserve the
 * structured issues only via the invocation lifecycle event bus, not the
 * client-facing HTTP response.
 */
function validateOutput(
	descriptor: TriggerDescriptor,
	rawOutput: unknown,
): ValidateOutputResult<unknown> {
	// Output crosses the sandbox bridge as a structured-cloned value; no
	// additional clone needed here.
	const result = descriptor.zodOutputSchema.safeParse(rawOutput);
	if (result.success) {
		return { ok: true, output: result.data };
	}
	return {
		ok: false,
		issues: zodIssuesToValidationIssues(result.error.issues),
	};
}

export type { ValidateOutputResult, ValidateResult };
export { validate, validateOutput, zodIssuesToValidationIssues };
