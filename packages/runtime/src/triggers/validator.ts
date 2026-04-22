import Ajv2020 from "ajv/dist/2020.js";
import { ajvPathToSegments, structuredCloneJson } from "../ajv-shared.js";
import type { TriggerDescriptor, ValidationIssue } from "../executor/types.js";

type ValidateResult<T = unknown> =
	| { readonly ok: true; readonly input: T }
	| { readonly ok: false; readonly issues: ValidationIssue[] };

type ValidateOutputResult<T = unknown> =
	| { readonly ok: true; readonly output: T }
	| { readonly ok: false; readonly issues: ValidationIssue[] };

const ajv = new Ajv2020.default({ allErrors: true, strict: false });

interface CompiledValidator {
	(value: unknown): boolean;
	errors?: {
		readonly instancePath: string;
		readonly message?: string;
	}[];
}

const compiledCache = new WeakMap<Record<string, unknown>, CompiledValidator>();

function compile(schema: Record<string, unknown>): CompiledValidator {
	const cached = compiledCache.get(schema);
	if (cached) {
		return cached;
	}
	// biome-ignore lint/suspicious/noExplicitAny: Ajv's compile signature uses a broad generic
	const fn = ajv.compile(schema as any) as CompiledValidator;
	compiledCache.set(schema, fn);
	return fn;
}

function issuesFromValidator(validator: CompiledValidator): ValidationIssue[] {
	return (validator.errors ?? []).map((err) => ({
		path: ajvPathToSegments(err.instancePath),
		message: err.message ?? "validation failed",
	}));
}

/**
 * Validate a raw trigger input against a descriptor's `inputSchema`.
 *
 * Kind-agnostic: every `TriggerSource` calls this before dispatching to the
 * executor. Callers decide the protocol-level response on failure (HTTP 422
 * for HTTP; log-and-drop for cron; etc.).
 */
function validate(
	descriptor: TriggerDescriptor,
	rawInput: unknown,
): ValidateResult<unknown> {
	const validator = compile(descriptor.inputSchema);
	const copy = structuredCloneJson(rawInput);
	const ok = validator(copy);
	if (ok) {
		return { ok: true, input: copy };
	}
	return { ok: false, issues: issuesFromValidator(validator) };
}

/**
 * Validate a handler's return value against a descriptor's `outputSchema`.
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
	const validator = compile(descriptor.outputSchema);
	// Output crosses the sandbox bridge as a structured-cloned value; no
	// additional clone needed. Pure predicate, never mutates.
	const ok = validator(rawOutput);
	if (ok) {
		return { ok: true, output: rawOutput };
	}
	return { ok: false, issues: issuesFromValidator(validator) };
}

export type { ValidateOutputResult, ValidateResult };
export { compile, validate, validateOutput };
