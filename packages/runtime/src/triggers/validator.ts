import Ajv2020 from "ajv/dist/2020.js";
import type { TriggerDescriptor, ValidationIssue } from "../executor/types.js";

type ValidateResult<T = unknown> =
	| { readonly ok: true; readonly input: T }
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

function ajvPathToSegments(instancePath: string): (string | number)[] {
	if (instancePath === "") {
		return [];
	}
	return instancePath
		.split("/")
		.slice(1)
		.map((seg) => {
			const n = Number(seg);
			return Number.isFinite(n) && seg !== "" ? n : seg;
		});
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
	const issues: ValidationIssue[] = (validator.errors ?? []).map((err) => ({
		path: ajvPathToSegments(err.instancePath),
		message: err.message ?? "validation failed",
	}));
	return { ok: false, issues };
}

export type { ValidateResult };
export { validate };
