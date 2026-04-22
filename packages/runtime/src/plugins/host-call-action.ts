import type { DepsMap, PluginSetup } from "@workflow-engine/sandbox";
import { ajvPathToSegments } from "../ajv-shared.js";

interface ValidationIssue {
	readonly path: (string | number)[];
	readonly message: string;
}

/**
 * Plain error subclass that the sdk-support plugin catches and surfaces to
 * the guest. Carries the Ajv errors array verbatim under `errors` plus a
 * normalized `issues` array (path-of-segments + message) — both shapes are
 * present so downstream handlers can introspect either.
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

interface AjvValidatorFn {
	(data: unknown): boolean;
	errors?: ReadonlyArray<{ instancePath?: string; message?: string }> | null;
}

/**
 * Per-action JSON-schema validator source, produced by Ajv's
 * `standaloneCode` on the main thread. The worker `new Function`s each
 * source into a plain predicate; no Ajv runtime is bundled into the worker.
 */
interface Config {
	readonly validatorSources: Readonly<Record<string, string>>;
}

const name = "host-call-action";
const dependsOn: readonly string[] = [];

/**
 * Instantiates pre-compiled per-action validators at `worker()` time and
 * exports `validateAction(name, input)` for consumption by sdk-support via
 * `dependsOn: ["host-call-action"]`. Registers no guest functions; the
 * only consumer is another plugin, not tenant code. Validators persist
 * for the sandbox's lifetime — no recompilation between runs.
 */
function worker(_ctx: unknown, _deps: DepsMap, config: Config): PluginSetup {
	const validators = new Map<string, AjvValidatorFn>();
	for (const [actionName, source] of Object.entries(config.validatorSources)) {
		validators.set(actionName, instantiateValidator(source));
	}

	const validateAction = (actionName: string, input: unknown): void => {
		const validator = validators.get(actionName);
		if (!validator) {
			throw new Error(`action "${actionName}" is not declared in the manifest`);
		}
		// Ajv is configured without `useDefaults`/`coerceTypes`; validators
		// are pure predicates and never mutate `input`. No defensive clone.
		const ok = validator(input);
		if (ok) {
			return;
		}
		const ajvErrors = validator.errors ?? [];
		const issues: ValidationIssue[] = ajvErrors.map((err) => ({
			path: ajvPathToSegments(err.instancePath ?? ""),
			message: err.message ?? "validation failed",
		}));
		throw new ValidationError(
			"action input validation failed",
			issues,
			ajvErrors,
		);
	};

	const exports: DepsMap["host-call-action"] = { validateAction };
	return { exports };
}

function instantiateValidator(source: string): AjvValidatorFn {
	// Ajv's `standaloneCode` emits CJS-shaped source (`module.exports = validate;
	// module.exports.default = validate;`). Wrap with a function-constructor
	// invocation that provides a minimal CJS module shim and returns whatever
	// the validator script installed onto module.exports.
	const loader = new Function(
		"module",
		"exports",
		`${source}; return module.exports;`,
	);
	const mod: { exports: unknown } = { exports: {} };
	const exported = loader(mod, mod.exports);
	const fn =
		typeof exported === "function"
			? exported
			: (mod.exports as { default?: unknown }).default;
	if (typeof fn !== "function") {
		throw new Error(
			"host-call-action: validator source did not default-export a function",
		);
	}
	return fn as AjvValidatorFn;
}

export type { Config, ValidationIssue };
export { dependsOn, instantiateValidator, name, ValidationError, worker };
