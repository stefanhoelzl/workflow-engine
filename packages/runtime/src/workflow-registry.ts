import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import {
	type Manifest,
	ManifestSchema,
	type WorkflowManifest,
} from "@workflow-engine/core";
import { type Sandbox, sandbox } from "@workflow-engine/sandbox";
import Ajv2020 from "ajv/dist/2020.js";
import { extract as tarExtract } from "tar-stream";
import type {
	ActionDescriptor,
	HttpTriggerDescriptor,
	WorkflowRunner,
} from "./executor/types.js";
import type { Logger } from "./logger.js";
import type { StorageBackend } from "./storage/index.js";
import type {
	HttpTriggerRegistry,
	PayloadValidator,
	ValidationIssue,
	ValidatorResult,
} from "./triggers/http.js";
import { createHttpTriggerRegistry } from "./triggers/http.js";

// ---------------------------------------------------------------------------
// Workflow registry (multi-tenant)
// ---------------------------------------------------------------------------
//
// Runners are keyed by `(tenant, name)`. The registry accepts tenant
// tarballs via `registerTenant(tenant, files)` and rebuilds from the
// storage backend at startup via `recover(backend)`.

const ajv = new Ajv2020.default({ allErrors: true, strict: false });

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
// Tenant tarball extraction
// ---------------------------------------------------------------------------

async function extractTenantTarGz(
	buffer: ArrayBuffer | Uint8Array,
): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	const extractor = tarExtract();
	extractor.on("entry", (header, stream, next) => {
		if (header.type === "file") {
			const chunks: Buffer[] = [];
			stream.on("data", (chunk: Buffer) => chunks.push(chunk));
			stream.on("end", () => {
				files.set(header.name, Buffer.concat(chunks).toString("utf-8"));
				next();
			});
		} else {
			stream.on("end", () => next());
			stream.resume();
		}
	});
	const input =
		buffer instanceof Uint8Array ? Buffer.from(buffer) : Buffer.from(buffer);
	await pipeline(Readable.from(input), createGunzip(), extractor);
	return files;
}

// ---------------------------------------------------------------------------
// __hostCallAction dispatcher (per workflow)
// ---------------------------------------------------------------------------

interface DispatcherDeps {
	readonly workflow: WorkflowManifest;
	readonly logger: Logger;
}

function buildHostCallAction(deps: DispatcherDeps) {
	const inputValidators = new Map<
		string,
		(value: unknown) => ValidatorResult<unknown>
	>();
	for (const action of deps.workflow.actions) {
		inputValidators.set(action.name, compileValidator(action.input));
	}

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
	const action = deps.workflow.actions.find((a) => a.name === name);
	if (!action) {
		throw new Error(`action "${name}" is not declared in the manifest`);
	}
	const validateInput = inputValidators.get(name);
	if (!validateInput) {
		throw new Error(`action "${name}" has no validator`);
	}
	const inputResult = validateInput(input);
	if (!inputResult.ok) {
		throwValidationError("action input validation failed", inputResult.issues);
	}
	deps.logger.info("action.invoked", {
		workflow: deps.workflow.name,
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

interface RunnerLifetime {
	readonly sandbox: Sandbox;
	isBusy: boolean;
	retiring: boolean;
}

function buildTriggerDescriptor(
	manifestEntry: WorkflowManifest["triggers"][number],
): HttpTriggerDescriptor {
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
	manifestEntry: WorkflowManifest["triggers"][number],
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
	readonly tenant: string;
	readonly workflow: WorkflowManifest;
	readonly bundleSource: string;
	readonly filename: string;
	readonly logger: Logger;
}

function buildActionDescriptors(
	workflow: WorkflowManifest,
): ActionDescriptor[] {
	const fallback = { parse: (x: unknown) => x };
	return workflow.actions.map((a) => ({
		name: a.name,
		input: fallback,
		output: fallback,
	}));
}

function buildHttpTriggers(workflow: WorkflowManifest): {
	descriptors: HttpTriggerDescriptor[];
	bindings: HttpTriggerBinding[];
} {
	const descriptors: HttpTriggerDescriptor[] = [];
	const bindings: HttpTriggerBinding[] = [];
	for (const manifestTrigger of workflow.triggers) {
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

// The action dispatcher implementation, appended as JS source to the sandbox
// bundle. The IIFE captures `__hostCallAction` and `__emitEvent` into closure
// locals, installs `__dispatchAction` as a locked (non-writable,
// non-configurable) global, then deletes the two captured bridge names from
// globalThis so guest code cannot read or overwrite them. The dispatcher
// itself is kept guest-callable by design (see sandbox spec
// `__dispatchAction locked guest global`) with the audit-log-poisoning
// residual documented in SECURITY.md §2.
const ACTION_DISPATCHER_SOURCE = `
(function() {
  var _hostCall = globalThis.__hostCallAction;
  var _emit = globalThis.__emitEvent;
  async function dispatch(name, input, handler, outputSchema) {
    _emit({ kind: "action.request", name, input });
    try {
      await _hostCall(name, input);
      const raw = await handler(input);
      const output = outputSchema.parse(raw);
      _emit({ kind: "action.response", name, output });
      return output;
    } catch (err) {
      const error = {
        message: err && err.message ? String(err.message) : String(err),
        stack: err && err.stack ? String(err.stack) : "",
      };
      if (err && err.issues !== undefined) error.issues = err.issues;
      _emit({ kind: "action.error", name, error });
      throw err;
    }
  }
  Object.defineProperty(globalThis, "__dispatchAction", {
    value: dispatch,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  delete globalThis.__hostCallAction;
  delete globalThis.__emitEvent;
})();
`;

function buildSandboxSource(bundleSource: string): string {
	return `${bundleSource}\n${ACTION_DISPATCHER_SOURCE}`;
}

function buildInvokeHandler(
	sb: Sandbox,
	tenant: string,
	workflow: WorkflowManifest,
) {
	return async function invokeHandler(
		invocationId: string,
		triggerName: string,
		payload: unknown,
	) {
		const runResult = await sb.run(triggerName, payload, {
			invocationId,
			tenant,
			workflow: workflow.name,
			workflowSha: workflow.sha,
		});
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
	const { tenant, workflow, bundleSource, filename, logger } = args;

	const __hostCallAction = buildHostCallAction({ workflow, logger });
	const sandboxSource = buildSandboxSource(bundleSource);

	const sb = await sandbox(
		sandboxSource,
		{ __hostCallAction },
		{
			filename,
			methodEventNames: { __hostCallAction: "host.validateAction" },
		},
	);

	const actionDescriptors = buildActionDescriptors(workflow);
	const { descriptors: triggerDescriptors, bindings: httpTriggers } =
		buildHttpTriggers(workflow);

	const runner: WorkflowRunner = {
		tenant,
		name: workflow.name,
		env: Object.freeze({ ...workflow.env }),
		actions: actionDescriptors,
		triggers: triggerDescriptors,
		invokeHandler: buildInvokeHandler(sb, tenant, workflow),
		onEvent(cb) {
			sb.onEvent(cb);
		},
	};

	return { runner, sandbox: sb, httpTriggers };
}

// ---------------------------------------------------------------------------
// Registry factory
// ---------------------------------------------------------------------------

function runnerKey(tenant: string, name: string): string {
	return `${tenant}/${name}`;
}

interface WorkflowRegistryOptions {
	readonly logger: Logger;
	readonly storageBackend?: StorageBackend;
}

interface RegisterTenantOptions {
	readonly tarballBytes?: Uint8Array;
}

interface WorkflowRegistry {
	readonly runners: readonly WorkflowRunner[];
	readonly triggerRegistry: HttpTriggerRegistry;
	lookupRunner(tenant: string, name: string): WorkflowRunner | undefined;
	registerTenant(
		tenant: string,
		files: Map<string, string>,
		opts?: RegisterTenantOptions,
	): Promise<RegisterResult>;
	recover(): Promise<void>;
	dispose(): void;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure composes all registry state and operations
function createWorkflowRegistry(
	options: WorkflowRegistryOptions,
): WorkflowRegistry {
	const triggerRegistry = createHttpTriggerRegistry();
	const runners: WorkflowRunner[] = [];
	const runnersByKey = new Map<string, WorkflowRunner>();
	const lifetimes = new Map<string, RunnerLifetime>();
	const retiringLifetimes = new Set<RunnerLifetime>();
	const backend = options.storageBackend;

	options.logger.info("workflow-registry.created");

	function removeRunner(key: string): void {
		const existing = runnersByKey.get(key);
		const lifetime = lifetimes.get(key);
		if (!(existing && lifetime)) {
			return;
		}
		const idx = runners.findIndex((r) => runnerKey(r.tenant, r.name) === key);
		if (idx >= 0) {
			runners.splice(idx, 1);
		}
		runnersByKey.delete(key);
		lifetimes.delete(key);
		triggerRegistry.removeRunner(existing.tenant, existing.name);

		// Per-workflow serialization (executor runQueue) guarantees at most one
		// in-flight invocation per sandbox at any moment. If idle, dispose now;
		// if busy, let the currently-running invocation finish, then dispose on
		// its terminal event (see onEvent hook in addRunner).
		if (lifetime.isBusy) {
			lifetime.retiring = true;
			retiringLifetimes.add(lifetime);
		} else {
			lifetime.sandbox.dispose();
		}
	}

	function addRunner(
		runner: WorkflowRunner,
		sb: Sandbox,
		bindings: HttpTriggerBinding[],
	): void {
		const key = runnerKey(runner.tenant, runner.name);
		const lifetime: RunnerLifetime = {
			sandbox: sb,
			isBusy: false,
			retiring: false,
		};
		runner.onEvent((event) => {
			if (event.kind === "trigger.request") {
				lifetime.isBusy = true;
			} else if (
				event.kind === "trigger.response" ||
				event.kind === "trigger.error"
			) {
				lifetime.isBusy = false;
				if (lifetime.retiring) {
					lifetime.sandbox.dispose();
					retiringLifetimes.delete(lifetime);
				}
			}
		});
		runners.push(runner);
		runnersByKey.set(key, runner);
		lifetimes.set(key, lifetime);
		for (const binding of bindings) {
			triggerRegistry.register(runner, binding.descriptor, binding.validator, {
				schema: binding.schema,
			});
		}
	}

	function parseManifest(
		tenant: string,
		manifestRaw: string,
	): { ok: true; manifest: Manifest } | { ok: false; result: RegisterResult } {
		try {
			const parsed: unknown = JSON.parse(manifestRaw);
			const manifest = ManifestSchema.parse(parsed);
			return { ok: true, manifest };
		} catch (err) {
			const shape = toRegisterIssue(err);
			options.logger.warn("workflow-registry.register-failed", {
				tenant,
				...shape,
			});
			return { ok: false, result: { ok: false, ...shape } };
		}
	}

	function validateModulesPresent(
		tenant: string,
		manifest: Manifest,
		files: Map<string, string>,
	): RegisterResult | undefined {
		for (const wf of manifest.workflows) {
			if (!files.has(wf.module)) {
				const error = `missing workflow module: ${wf.module}`;
				options.logger.warn("workflow-registry.register-failed", {
					tenant,
					workflow: wf.name,
					error,
				});
				return { ok: false, error };
			}
		}
	}

	async function buildTenantArtifacts(
		tenant: string,
		manifest: Manifest,
		files: Map<string, string>,
	): Promise<RunnerArtifacts[]> {
		const artifacts: RunnerArtifacts[] = [];
		for (const wf of manifest.workflows) {
			const bundleSource = files.get(wf.module);
			if (bundleSource === undefined) {
				continue;
			}
			// biome-ignore lint/performance/noAwaitInLoops: sequential sandbox construction avoids concurrent worker startup
			const artifact = await buildRunner({
				tenant,
				workflow: wf,
				bundleSource,
				filename: `${wf.name}.js`,
				logger: options.logger,
			});
			artifacts.push(artifact);
		}
		return artifacts;
	}

	function swapTenantRunners(
		tenant: string,
		artifacts: RunnerArtifacts[],
	): void {
		for (const key of Array.from(runnersByKey.keys())) {
			if (key.startsWith(`${tenant}/`)) {
				removeRunner(key);
			}
		}
		for (const artifact of artifacts) {
			addRunner(artifact.runner, artifact.sandbox, artifact.httpTriggers);
		}
	}

	async function persistTarball(
		tenant: string,
		bytes: Uint8Array,
	): Promise<{ ok: true } | { ok: false; error: string }> {
		if (!backend) {
			return { ok: true };
		}
		const finalKey = `workflows/${tenant}.tar.gz`;
		const tempKey = `${finalKey}.upload-${crypto.randomUUID()}`;
		try {
			await backend.writeBytes(tempKey, bytes);
			await backend.move(tempKey, finalKey);
			return { ok: true };
		} catch (err) {
			try {
				await backend.remove(tempKey);
			} catch {
				// best-effort cleanup
			}
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async function persistIfRequested(
		tenant: string,
		artifacts: RunnerArtifacts[],
		opts: RegisterTenantOptions | undefined,
	): Promise<RegisterResult | undefined> {
		if (!(opts?.tarballBytes && backend)) {
			return;
		}
		const persisted = await persistTarball(tenant, opts.tarballBytes);
		if (persisted.ok) {
			return;
		}
		// Persistence failed; discard freshly built artifacts to avoid sandbox
		// leaks. Keep existing runners unchanged.
		for (const a of artifacts) {
			a.sandbox.dispose();
		}
		const error = `failed to persist tenant bundle: ${persisted.error}`;
		options.logger.error("workflow-registry.persist-failed", {
			tenant,
			error,
		});
		return { ok: false, error };
	}

	async function registerTenant(
		tenant: string,
		files: Map<string, string>,
		opts?: RegisterTenantOptions,
	): Promise<RegisterResult> {
		const manifestRaw = files.get("manifest.json");
		if (manifestRaw === undefined) {
			options.logger.warn("workflow-registry.register-failed", {
				tenant,
				error: "missing manifest.json",
			});
			return { ok: false, error: "missing manifest.json" };
		}
		const parseResult = parseManifest(tenant, manifestRaw);
		if (!parseResult.ok) {
			return parseResult.result;
		}
		const { manifest } = parseResult;
		const modulesCheck = validateModulesPresent(tenant, manifest, files);
		if (modulesCheck) {
			return modulesCheck;
		}
		const artifacts = await buildTenantArtifacts(tenant, manifest, files);
		const persistFailure = await persistIfRequested(tenant, artifacts, opts);
		if (persistFailure) {
			return persistFailure;
		}
		swapTenantRunners(tenant, artifacts);
		options.logger.info("workflow-registry.registered", {
			tenant,
			workflows: manifest.workflows.length,
		});
		return {
			ok: true,
			tenant,
			workflows: manifest.workflows.map((w) => w.name),
		};
	}

	async function recoverOne(
		tenantBackend: StorageBackend,
		key: string,
	): Promise<void> {
		const tenant = key.slice(
			"workflows/".length,
			key.length - ".tar.gz".length,
		);
		try {
			const bytes = await tenantBackend.readBytes(key);
			const files = await extractTenantTarGz(bytes);
			const result = await registerTenant(tenant, files);
			if (!result.ok) {
				options.logger.error("workflow-registry.recover-failed", {
					tenant,
					error: result.error,
				});
			}
		} catch (err) {
			options.logger.error("workflow-registry.recover-failed", {
				tenant,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	async function recover(): Promise<void> {
		if (!backend) {
			return;
		}
		for await (const key of backend.list("workflows/")) {
			if (!key.endsWith(".tar.gz")) {
				continue;
			}
			await recoverOne(backend, key);
		}
	}

	return {
		get runners() {
			return runners;
		},
		get triggerRegistry() {
			return triggerRegistry;
		},
		lookupRunner(tenant: string, name: string) {
			return runnersByKey.get(runnerKey(tenant, name));
		},
		registerTenant,
		recover,
		dispose() {
			for (const lifetime of lifetimes.values()) {
				lifetime.sandbox.dispose();
			}
			lifetimes.clear();
			for (const lifetime of retiringLifetimes) {
				lifetime.sandbox.dispose();
			}
			retiringLifetimes.clear();
		},
	};
}

// ---------------------------------------------------------------------------
// Upload result
// ---------------------------------------------------------------------------

interface ManifestIssue {
	readonly path: (string | number)[];
	readonly message: string;
}

type RegisterResult =
	| { ok: true; tenant: string; workflows: string[] }
	| { ok: false; error: string; issues?: ManifestIssue[] };

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
	ManifestIssue,
	RegisterResult,
	WorkflowRegistry,
	WorkflowRegistryOptions,
};
export { createWorkflowRegistry, extractTenantTarGz };
