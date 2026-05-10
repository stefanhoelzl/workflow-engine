import { z } from "@workflow-engine/core";
import type { DepsMap, PluginSetup } from "@workflow-engine/sandbox";
import { GuestSafeError } from "@workflow-engine/sandbox";

interface ValidationIssue {
	readonly path: (string | number)[];
	readonly message: string;
	readonly received?: unknown;
	readonly expected?: string;
	readonly code?: string;
}

/**
 * Plain error subclass that the action-dispatch plugin catches and surfaces to
 * the guest. Carries the underlying validator's raw issue array under
 * `errors` plus a normalised `issues` array (path-of-segments + message) —
 * both shapes are present so downstream handlers can introspect either.
 * After the Ajv→Zod swap the raw shape is `ZodIssue[]`; the normalised
 * shape is engine-agnostic and unchanged.
 */
class ValidationError extends Error {
	readonly name = "ValidationError";
	readonly issues: readonly ValidationIssue[];
	readonly errors: unknown;
	constructor(
		message: string,
		issues: readonly ValidationIssue[],
		errors: unknown,
	) {
		super(message);
		this.issues = issues;
		this.errors = errors;
	}
}

/**
 * Per-action JSON-Schema map shipped from the main thread. The plugin's
 * `worker()` rehydrates each schema into a Zod validator via
 * `z.fromJSONSchema()` at sandbox boot; per-call rehydration is forbidden.
 * Both maps are JSON-serialisable (plain JSON Schema objects), which is the
 * gate that lets them cross the worker-thread `postMessage` boundary.
 */
interface Config {
	readonly inputSchemas: Readonly<Record<string, Record<string, unknown>>>;
	readonly outputSchemas: Readonly<Record<string, Record<string, unknown>>>;
}

const name = "host-call-action";
const dependsOn: readonly string[] = [];

function rehydrateValidators(
	schemas: Readonly<Record<string, Record<string, unknown>>>,
): Map<string, z.ZodType<unknown>> {
	const validators = new Map<string, z.ZodType<unknown>>();
	for (const [actionName, schema] of Object.entries(schemas)) {
		validators.set(actionName, z.fromJSONSchema(schema) as z.ZodType<unknown>);
	}
	return validators;
}

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

function runValidator(
	validators: Map<string, z.ZodType<unknown>>,
	actionName: string,
	value: unknown,
	errorLabel: string,
): unknown {
	const validator = validators.get(actionName);
	if (!validator) {
		// GuestSafeError so the bridge-closure rule preserves the message
		// when this throw crosses into the guest VM via the dispatchAction
		// descriptor. "in the manifest" is dropped — manifest is a build-
		// pipeline term, not part of the workflow-author surface.
		throw new GuestSafeError(`action "${actionName}" is not declared`);
	}
	const result = validator.safeParse(value);
	if (result.success) {
		return result.data;
	}
	throw new ValidationError(
		errorLabel,
		zodIssuesToValidationIssues(result.error.issues, value),
		result.error.issues,
	);
}

/**
 * Rehydrates per-action Zod validators at `worker()` boot and exports
 * `validateAction(name, input)` + `validateActionOutput(name, output)` for
 * consumption by action-dispatch via `dependsOn: ["host-call-action"]`.
 * Validators persist for the sandbox's lifetime; no rehydration between
 * runs.
 */
function worker(_ctx: unknown, _deps: DepsMap, config: Config): PluginSetup {
	const inputValidators = rehydrateValidators(config.inputSchemas);
	const outputValidators = rehydrateValidators(config.outputSchemas);

	const validateAction = (actionName: string, input: unknown): void => {
		runValidator(
			inputValidators,
			actionName,
			input,
			"action input validation failed",
		);
	};

	const validateActionOutput = (actionName: string, output: unknown): unknown =>
		runValidator(
			outputValidators,
			actionName,
			output,
			"action output validation failed",
		);

	const exports: DepsMap["host-call-action"] = {
		validateAction,
		validateActionOutput,
	};
	return { exports };
}

export type { Config, ValidationIssue };
export { dependsOn, name, ValidationError, worker };
