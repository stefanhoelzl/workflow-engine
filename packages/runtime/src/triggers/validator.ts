import type { z } from "@workflow-engine/core";
import type { TriggerDescriptor, ValidationIssue } from "../executor/types.js";

type ValidateResult<T = unknown> =
	| { readonly ok: true; readonly input: T }
	| { readonly ok: false; readonly issues: ValidationIssue[] };

type ValidateOutputResult<T = unknown> =
	| { readonly ok: true; readonly output: T }
	| { readonly ok: false; readonly issues: ValidationIssue[] };

/**
 * Lift the value at `path` from `input`. Used as a fallback for issues that
 * lack zod's `input` field; for normal zod v4 issues we read `issue.input`
 * directly which already carries the value at the failure point.
 */
function liftAtPath(
	input: unknown,
	path: readonly (string | number)[],
): unknown {
	let cur: unknown = input;
	for (const seg of path) {
		if (cur === null || cur === undefined) {
			return;
		}
		cur = (cur as Record<string | number, unknown>)[seg];
	}
	return cur;
}

/**
 * Derive an engine-stable `expected` string from a zod issue's code-specific
 * fields. Returns undefined when the code carries no useful constraint
 * description.
 */
function deriveExpected(issue: z.core.$ZodIssue): string | undefined {
	switch (issue.code) {
		case "invalid_type":
			return issue.expected;
		case "invalid_value": {
			const values = issue.values
				.map((v: unknown) => (typeof v === "string" ? `"${v}"` : String(v)))
				.join(", ");
			return `one of [${values}]`;
		}
		case "too_big": {
			const op = issue.inclusive === false ? "<" : "<=";
			return `${op} ${String(issue.maximum)}`;
		}
		case "too_small": {
			const op = issue.inclusive === false ? ">" : ">=";
			return `${op} ${String(issue.minimum)}`;
		}
		case "invalid_format":
			return issue.format;
		case "unrecognized_keys":
			return `no unrecognized keys (got [${issue.keys.map((k: string) => `"${k}"`).join(", ")}])`;
		case "not_multiple_of":
			return `multiple of ${String(issue.divisor)}`;
		default:
			return;
	}
}

/**
 * Map raw `ZodIssue[]` into the engine-agnostic `ValidationIssue[]` shape
 * with enriched `received`, `expected`, `code` fields (per
 * payload-validation/spec.md "Validation errors carry structured issues").
 * The mapper is shared by every trigger source and by the host-call-action
 * plugin; the wire boundary projects to the minimal shape via
 * `toWireIssues`.
 */
function zodIssuesToValidationIssues(
	issues: readonly z.core.$ZodIssue[],
	input?: unknown,
): ValidationIssue[] {
	return issues.map((issue) => {
		const path = [...issue.path] as (string | number)[];
		const received =
			issue.input === undefined ? liftAtPath(input, path) : issue.input;
		const expected = deriveExpected(issue);
		return {
			path,
			message: issue.message,
			...(received === undefined ? {} : { received }),
			...(expected === undefined ? {} : { expected }),
			code: issue.code,
		};
	});
}

/**
 * Project `ValidationIssue[]` to the minimal `{path, message}` shape used on
 * the public-by-design HTTP 422 surface. Strips `received`, `expected`,
 * `code` — the wire MUST NOT expose library-specific error details per
 * `payload-validation/spec.md` "HTTP 422 response for validation failures".
 */
function toWireIssues(
	issues: readonly ValidationIssue[],
): { readonly path: readonly (string | number)[]; readonly message: string }[] {
	return issues.map((issue) => ({ path: issue.path, message: issue.message }));
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
		issues: zodIssuesToValidationIssues(result.error.issues, copy),
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
		issues: zodIssuesToValidationIssues(result.error.issues, rawOutput),
	};
}

export type { ValidateOutputResult, ValidateResult };
export { toWireIssues, validate, validateOutput, zodIssuesToValidationIssues };
