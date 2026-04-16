import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { type Manifest, ManifestSchema } from "@workflow-engine/core";
import { type Sandbox, sandbox } from "@workflow-engine/sandbox";
import Ajv2020 from "ajv/dist/2020.js";
import type {
	ActionDescriptor,
	HttpTriggerDescriptor,
	WorkflowRunner,
} from "./executor/types.js";
import type { Logger } from "./logger.js";
import type {
	HttpTriggerRegistry,
	PayloadValidator,
	ValidationIssue,
	ValidatorResult,
} from "./triggers/http.js";
import { createHttpTriggerRegistry } from "./triggers/http.js";

// ---------------------------------------------------------------------------
// Workflow registry (v1)
// ---------------------------------------------------------------------------
//
// `createWorkflowRegistry({ logger })` returns an empty registry. Call
// `loadWorkflows(registry, manifestPaths, { logger })` once at startup to
// populate it, or `loadWorkflow(registry, manifestPath, { logger })` to
// add/replace a single workflow at runtime (used by the upload pipeline).
// Per manifest the registry:
//   1. Validates the v1 ManifestSchema (Zod).
//   2. Reads the per-workflow bundle from `<dir>/<manifest.module>`.
//   3. Constructs a QuickJS `Sandbox` passing `__hostCallAction` as a
//      per-workflow host method.
//   4. Builds a `WorkflowRunner` (name/env/actions/triggers/invokeHandler)
//      and appends it to the registry's runners list.
//   5. Registers each HTTP trigger with its JSON-Schema-based
//      `PayloadValidator` against the runtime's `HttpTriggerRegistry`.
//
// §1 Corrected dispatch model (design D11):
//   Action handlers run INSIDE the sandbox via the SDK wrapper (see
//   `packages/sdk/src/index.ts`). The wrapper calls `__hostCallAction`
//   for input validation + audit logging only; it then invokes the
//   author's handler in-sandbox via a direct JS function call (same
//   QuickJS context, no nested `sandbox.run()`). Output validation
//   happens in-sandbox via the inlined Zod schema. The host therefore
//   does NOT re-enter the sandbox to dispatch the handler, and
//   `sandbox.run()` is never called nested.
//
// §2 SECURITY-adjacent: the dispatcher validates action input against the
// manifest JSON Schema (Ajv) on every call and audit-logs the invocation.
// Validation errors propagate back to the guest as `Error`s with a
// JSON-serializable `.issues` array (Zod/Ajv-compatible shape).

// ---------------------------------------------------------------------------
// Ajv validator helpers
// ---------------------------------------------------------------------------

const ajv = new Ajv2020.default({ allErrors: true, strict: false });

function structuredCloneJson<T>(value: T): T {
	// JSON round-trip = strip prototype-pollution keys, functions, symbols,
	// etc. Matches the sandbox's JSON-only contract (SECURITY.md §2/§3 W1).
	if (value === undefined) {
		return value;
	}
	try {
		return JSON.parse(JSON.stringify(value)) as T;
	} catch {
		return value;
	}
}

function compileValidator(
	schema: unknown,
): (value: unknown) => ValidatorResult<unknown> {
	// biome-ignore lint/suspicious/noExplicitAny: Ajv's compile signature uses a broad generic
	const validate = ajv.compile(schema as any);
	return (value: unknown) => {
		const copy = structuredCloneJson(value);
		const ok = validate(copy);
		if (ok) {
			return { ok: true, value: copy };
		}
		const issues: ValidationIssue[] = (validate.errors ?? []).map((err) => ({
			path: ajvPathToSegments(err.instancePath),
			message: err.message ?? "validation failed",
		}));
		return { ok: false, issues };
	};
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

// ---------------------------------------------------------------------------
// Manifest + bundle loading
// ---------------------------------------------------------------------------

interface LoadedBundle {
	readonly manifestPath: string;
	readonly manifest: Manifest;
	readonly bundleSource: string;
	readonly bundlePath: string;
}

async function loadOneBundle(manifestPath: string): Promise<LoadedBundle> {
	const raw = await readFile(manifestPath, "utf8");
	const parsed: unknown = JSON.parse(raw);
	const manifest = ManifestSchema.parse(parsed);
	const bundleDir = dirname(manifestPath);
	const bundlePath = resolve(bundleDir, manifest.module);
	const bundleSource = await readFile(bundlePath, "utf8");
	return { manifestPath, manifest, bundleSource, bundlePath };
}

// ---------------------------------------------------------------------------
// __hostCallAction dispatcher (per workflow)
// ---------------------------------------------------------------------------
//
// Responsibility: input validation + audit logging. That's all. The SDK
// wrapper inside the sandbox runs the handler and validates the output
// after this returns. We deliberately return `undefined` so the sandbox
// side doesn't need to care about the host's return value.

interface DispatcherDeps {
	readonly manifest: Manifest;
	readonly logger: Logger;
}

function buildHostCallAction(deps: DispatcherDeps) {
	const inputValidators = new Map<
		string,
		(value: unknown) => ValidatorResult<unknown>
	>();
	for (const action of deps.manifest.actions) {
		inputValidators.set(action.name, compileValidator(action.input));
	}

	// The dispatcher only validates + logs — no I/O, no awaiting. The
	// sandbox bridge requires a Promise-returning host method, so we
	// synchronously build a resolved Promise. Throws propagate as
	// rejections into the guest.
	return (...args: unknown[]): Promise<undefined> => {
		try {
			dispatchActionCall(deps, inputValidators, args);
			return Promise.resolve(undefined);
		} catch (err) {
			return Promise.reject(err);
		}
	};
}

function dispatchActionCall(
	deps: DispatcherDeps,
	inputValidators: Map<string, (value: unknown) => ValidatorResult<unknown>>,
	args: unknown[],
): void {
	const [name, input] = args as [string, unknown];
	const action = deps.manifest.actions.find((a) => a.name === name);
	if (!action) {
		throw new Error(`action "${name}" is not declared in the manifest`);
	}
	const validateInput = inputValidators.get(name);
	if (!validateInput) {
		// unreachable given the manifest loop above — defensive.
		throw new Error(`action "${name}" has no validator`);
	}
	const inputResult = validateInput(input);
	if (!inputResult.ok) {
		throwValidationError("action input validation failed", inputResult.issues);
	}
	deps.logger.info("action.invoked", {
		workflow: deps.manifest.name,
		action: name,
		input: inputResult.value,
	});
}

function throwValidationError(
	message: string,
	issues: ValidationIssue[] | undefined,
): never {
	const err = new Error(message) as Error & { issues?: unknown };
	err.name = "ValidationError";
	err.issues = issues ?? [];
	throw err;
}

// ---------------------------------------------------------------------------
// Trigger dispatcher shim
// ---------------------------------------------------------------------------
//
// Trigger exports are plain objects (`{handler, body, ...}`). The sandbox's
// `run(name, ctx)` calls `<name>(ctx)` which fails for an object. We append
// a shim per trigger that re-exports `(payload) => <trigger>.handler(payload)`
// under a deterministic name. The shim name is a reserved namespace
// (`__trigger_<name>`) guarded by a regex that refuses name clashes at build
// time — though for v1 we assume trigger export names don't start with
// `__trigger_`.

const TRIGGER_SHIM_PREFIX = "__trigger_";

function triggerShimName(triggerName: string): string {
	return `${TRIGGER_SHIM_PREFIX}${triggerName}`;
}

function buildTriggerShim(triggerNames: readonly string[]): string {
	return triggerNames
		.map(
			(name) =>
				`export const ${triggerShimName(name)} = async (p) => await ${name}.handler(p);`,
		)
		.join("\n");
}

// The SDK's `action()` callable lazily resolves its name via
// `__setActionName`, which the vite-plugin calls at build time. Hand-rolled
// test bundles do not call it; even plugin-built bundles rely on the vite-
// plugin having called `__setActionName` on the SAME Action instance before
// import. In the sandbox the module is re-evaluated from source, so the
// sandbox's copy is a fresh instance without a bound name. Append a tiny
// binder call per action so the sandbox copy is properly named before any
// trigger handler runs.
function buildActionNameBinder(actionNames: readonly string[]): string {
	return actionNames
		.map(
			(name) =>
				`if (typeof ${name} === "function" && typeof ${name}.__setActionName === "function") ${name}.__setActionName(${JSON.stringify(name)});`,
		)
		.join("\n");
}

// ---------------------------------------------------------------------------
// WorkflowRunner construction
// ---------------------------------------------------------------------------

interface HttpTriggerBinding {
	readonly descriptor: HttpTriggerDescriptor;
	readonly validator: PayloadValidator;
	readonly schema: Record<string, unknown>;
}

interface RunnerArtifacts {
	readonly runner: WorkflowRunner;
	readonly sandbox: Sandbox;
	readonly httpTriggers: HttpTriggerBinding[];
}

function buildTriggerDescriptor(
	manifestEntry: Manifest["triggers"][number],
): HttpTriggerDescriptor {
	// The executor treats schemas as opaque `{ parse(data) }` containers —
	// the descriptor's schema slots are reserved for future typed programmatic
	// trigger invocation. At runtime, payload validation for HTTP ingress is
	// driven by the JSON-Schema `PayloadValidator`, not these descriptor
	// schemas.
	const fallback = { parse: (x: unknown) => x };
	const descriptor: HttpTriggerDescriptor = {
		name: manifestEntry.name,
		type: "http",
		path: manifestEntry.path,
		method: manifestEntry.method,
		params: [...manifestEntry.params],
		body: fallback,
	};
	if (manifestEntry.query) {
		return { ...descriptor, query: fallback };
	}
	return descriptor;
}

function buildValidatorFromManifestTrigger(
	manifestEntry: Manifest["triggers"][number],
): PayloadValidator {
	const validateBody = compileValidator(manifestEntry.body);
	const validateParams = compileValidator({
		type: "object",
		properties: Object.fromEntries(
			manifestEntry.params.map((p) => [p, { type: "string" }]),
		),
		required: manifestEntry.params,
		additionalProperties: true,
	});
	const validateQuery = manifestEntry.query
		? compileValidator(manifestEntry.query)
		: (value: unknown): ValidatorResult<unknown> => ({ ok: true, value });
	return { validateBody, validateQuery, validateParams };
}

interface BuildRunnerArgs {
	readonly manifest: Manifest;
	readonly bundleSource: string;
	readonly filename: string;
	readonly logger: Logger;
}

function buildActionDescriptors(manifest: Manifest): ActionDescriptor[] {
	const fallback = { parse: (x: unknown) => x };
	return manifest.actions.map((a) => ({
		name: a.name,
		input: fallback,
		output: fallback,
	}));
}

function buildHttpTriggers(manifest: Manifest): {
	descriptors: HttpTriggerDescriptor[];
	bindings: HttpTriggerBinding[];
} {
	const descriptors: HttpTriggerDescriptor[] = [];
	const bindings: HttpTriggerBinding[] = [];
	for (const manifestTrigger of manifest.triggers) {
		const descriptor = buildTriggerDescriptor(manifestTrigger);
		descriptors.push(descriptor);
		bindings.push({
			descriptor,
			validator: buildValidatorFromManifestTrigger(manifestTrigger),
			schema: manifestTrigger.schema as Record<string, unknown>,
		});
	}
	return { descriptors, bindings };
}

function buildSandboxSource(manifest: Manifest, bundleSource: string): string {
	// The bundle's trigger exports are plain objects (`{handler, body, ...}`)
	// — calling `sb.run("triggerName", payload)` would try to invoke the
	// object as a function. Append a dispatcher shim per trigger that wraps
	// the handler call. The shim names are namespaced (`__trigger_<name>`)
	// so they never collide with user exports.
	const shim = buildTriggerShim(manifest.triggers.map((t) => t.name));
	// Bind every manifest-declared action so the sandbox-side Action callable
	// has its name set before any trigger handler runs. Non-declared exports
	// that call the sandbox's `action()` factory also self-name via the
	// vite-plugin (build time) or remain anonymous and surface as an
	// "unbound action" error at invocation time — both of which are correct
	// failure modes.
	const nameBinder = buildActionNameBinder(manifest.actions.map((a) => a.name));
	return `${bundleSource}\n${nameBinder}\n${shim}`;
}

function buildInvokeHandler(sb: Sandbox) {
	return async function invokeHandler(triggerName: string, payload: unknown) {
		const exportName = triggerShimName(triggerName);
		const runResult = await sb.run(exportName, payload);
		if (!runResult.ok) {
			const err = new Error(runResult.error.message);
			err.stack = runResult.error.stack;
			throw err;
		}
		return runResult.result as {
			status?: number;
			body?: unknown;
			headers?: Record<string, string>;
		};
	};
}

async function buildRunner(args: BuildRunnerArgs): Promise<RunnerArtifacts> {
	const { manifest, bundleSource, filename, logger } = args;

	const __hostCallAction = buildHostCallAction({ manifest, logger });
	const sourceWithShim = buildSandboxSource(manifest, bundleSource);

	const sb = await sandbox(sourceWithShim, { __hostCallAction }, { filename });

	const actionDescriptors = buildActionDescriptors(manifest);
	const { descriptors: triggerDescriptors, bindings: httpTriggers } =
		buildHttpTriggers(manifest);

	const runner: WorkflowRunner = {
		name: manifest.name,
		env: Object.freeze({ ...manifest.env }),
		actions: actionDescriptors,
		triggers: triggerDescriptors,
		invokeHandler: buildInvokeHandler(sb),
	};

	return { runner, sandbox: sb, httpTriggers };
}

// ---------------------------------------------------------------------------
// Registry factory + load APIs
// ---------------------------------------------------------------------------

interface WorkflowRegistryOptions {
	readonly logger: Logger;
}

interface WorkflowRegistry {
	readonly runners: readonly WorkflowRunner[];
	readonly triggerRegistry: HttpTriggerRegistry;
	lookupRunner(workflowName: string): WorkflowRunner | undefined;
	dispose(): void;
}

interface RegistryInternals {
	readonly addRunner: (runner: WorkflowRunner, sandbox: Sandbox) => void;
	readonly replaceRunner: (runner: WorkflowRunner, sandbox: Sandbox) => void;
}

const INTERNALS = new WeakMap<WorkflowRegistry, RegistryInternals>();

function createWorkflowRegistry(
	options: WorkflowRegistryOptions,
): WorkflowRegistry {
	const triggerRegistry = createHttpTriggerRegistry();
	const runners: WorkflowRunner[] = [];
	const sandboxes: Sandbox[] = [];
	const runnersByName = new Map<string, WorkflowRunner>();
	const sandboxesByName = new Map<string, Sandbox>();

	options.logger.info("workflow-registry.created");

	const registry: WorkflowRegistry = {
		get runners() {
			return runners;
		},
		get triggerRegistry() {
			return triggerRegistry;
		},
		lookupRunner(name: string) {
			return runnersByName.get(name);
		},
		dispose() {
			for (const sb of sandboxes) {
				sb.dispose();
			}
		},
	};
	INTERNALS.set(registry, {
		addRunner(runner, sb) {
			runners.push(runner);
			runnersByName.set(runner.name, runner);
			sandboxes.push(sb);
			sandboxesByName.set(runner.name, sb);
		},
		replaceRunner(runner, sb) {
			const oldSandbox = sandboxesByName.get(runner.name);
			const oldIdx = runners.findIndex((r) => r.name === runner.name);
			if (oldIdx >= 0) {
				runners.splice(oldIdx, 1);
			}
			if (oldSandbox) {
				const si = sandboxes.indexOf(oldSandbox);
				if (si >= 0) {
					sandboxes.splice(si, 1);
				}
				oldSandbox.dispose();
			}
			triggerRegistry.removeWorkflow(runner.name);
			runners.push(runner);
			runnersByName.set(runner.name, runner);
			sandboxes.push(sb);
			sandboxesByName.set(runner.name, sb);
		},
	});
	return registry;
}

interface LoadWorkflowsOptions {
	readonly logger: Logger;
}

async function loadWorkflows(
	registry: WorkflowRegistry,
	manifestPaths: readonly string[],
	options: LoadWorkflowsOptions,
): Promise<void> {
	for (const manifestPath of manifestPaths) {
		// biome-ignore lint/performance/noAwaitInLoops: sequential loading avoids spawning many worker threads at once
		await loadOne(registry, manifestPath, options);
	}
}

async function loadOne(
	registry: WorkflowRegistry,
	manifestPath: string,
	options: LoadWorkflowsOptions,
): Promise<void> {
	const internals = INTERNALS.get(registry);
	if (!internals) {
		throw new Error("workflow-registry: internals not initialised");
	}
	try {
		const loaded = await loadOneBundle(manifestPath);
		const artifacts = await buildRunner({
			manifest: loaded.manifest,
			bundleSource: loaded.bundleSource,
			filename: `${loaded.manifest.name}.js`,
			logger: options.logger,
		});
		internals.addRunner(artifacts.runner, artifacts.sandbox);
		for (const binding of artifacts.httpTriggers) {
			registry.triggerRegistry.register(
				artifacts.runner,
				binding.descriptor,
				binding.validator,
				{ schema: binding.schema },
			);
		}
		options.logger.info("workflow-registry.loaded", {
			workflow: loaded.manifest.name,
			actions: loaded.manifest.actions.length,
			triggers: loaded.manifest.triggers.length,
		});
	} catch (err) {
		options.logger.error("workflow-registry.load-failed", {
			manifestPath,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ---------------------------------------------------------------------------
// Upload path: register a workflow from in-memory files
// ---------------------------------------------------------------------------
//
// The /api/workflows upload endpoint POSTs a tarball containing
// `manifest.json` + `<name>.js`. The api/upload handler extracts the files
// and calls `registerFromFiles()`. On success, the workflow is added to the
// registry; on manifest validation failure a structured `RegisterResult` is
// returned for the HTTP layer to surface as 422.

interface ManifestIssue {
	readonly path: (string | number)[];
	readonly message: string;
}

type RegisterResult =
	| { ok: true; name: string }
	| { ok: false; error: string; issues?: ManifestIssue[] };

interface RegisterFromFilesOptions {
	readonly logger: Logger;
}

async function registerFromFiles(
	registry: WorkflowRegistry,
	files: Map<string, string>,
	options: RegisterFromFilesOptions,
): Promise<RegisterResult> {
	const manifestRaw = files.get("manifest.json");
	if (manifestRaw === undefined) {
		options.logger.warn("workflow-registry.register-failed", {
			error: "missing manifest.json",
		});
		return { ok: false, error: "missing manifest.json" };
	}
	let manifest: Manifest;
	try {
		const parsed: unknown = JSON.parse(manifestRaw);
		manifest = ManifestSchema.parse(parsed);
	} catch (err) {
		const shape = toRegisterIssue(err);
		options.logger.warn("workflow-registry.register-failed", shape);
		return { ok: false, ...shape };
	}
	const bundleSource = files.get(manifest.module);
	if (bundleSource === undefined) {
		const error = `missing action module: ${manifest.module}`;
		options.logger.warn("workflow-registry.register-failed", {
			name: manifest.name,
			error,
		});
		return { ok: false, error };
	}
	const internals = INTERNALS.get(registry);
	if (!internals) {
		throw new Error("workflow-registry: internals not initialised");
	}
	const artifacts = await buildRunner({
		manifest,
		bundleSource,
		filename: `${manifest.name}.js`,
		logger: options.logger,
	});
	internals.replaceRunner(artifacts.runner, artifacts.sandbox);
	for (const binding of artifacts.httpTriggers) {
		registry.triggerRegistry.register(
			artifacts.runner,
			binding.descriptor,
			binding.validator,
			{ schema: binding.schema },
		);
	}
	options.logger.info("workflow-registry.registered", { name: manifest.name });
	return { ok: true, name: manifest.name };
}

function normalizeIssue(raw: unknown): ManifestIssue | undefined {
	if (typeof raw !== "object" || raw === null) {
		return;
	}
	const rec = raw as Record<string, unknown>;
	const path = Array.isArray(rec.path)
		? (rec.path as unknown[]).filter(
				(p): p is string | number =>
					typeof p === "string" || typeof p === "number",
			)
		: [];
	const message = typeof rec.message === "string" ? rec.message : "";
	return { path, message };
}

function toRegisterIssue(err: unknown): {
	error: string;
	issues?: ManifestIssue[];
} {
	if (err && typeof err === "object" && "issues" in err) {
		const zodIssues = (err as { issues: unknown[] }).issues;
		const issues: ManifestIssue[] = [];
		for (const raw of zodIssues) {
			const normalized = normalizeIssue(raw);
			if (normalized) {
				issues.push(normalized);
			}
		}
		const message = err instanceof Error ? err.message : "validation failed";
		return {
			error: `invalid manifest: ${message}`,
			issues,
		};
	}
	return {
		error: `invalid manifest: ${err instanceof Error ? err.message : String(err)}`,
	};
}

export type {
	LoadWorkflowsOptions,
	ManifestIssue,
	RegisterFromFilesOptions,
	RegisterResult,
	WorkflowRegistry,
	WorkflowRegistryOptions,
};
export { createWorkflowRegistry, loadWorkflows, registerFromFiles };
