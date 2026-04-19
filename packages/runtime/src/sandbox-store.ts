import type { WorkflowManifest } from "@workflow-engine/core";
import type { Sandbox, SandboxFactory } from "@workflow-engine/sandbox";
import Ajv2020 from "ajv/dist/2020.js";
import type { Logger } from "./logger.js";

// Ajv-backed validator inlined here — the action-input validation happens
// at the host bridge and is independent of trigger-kind validation (which
// lives in triggers/validator.ts). Keeping the action validator types local
// avoids a cross-file import for a small internal contract.

interface ValidationIssue {
	readonly path: (string | number)[];
	readonly message: string;
}

interface ValidatorResult<T> {
	readonly ok: boolean;
	readonly value?: T;
	readonly issues?: ValidationIssue[];
}

// ---------------------------------------------------------------------------
// SandboxStore: per-(tenant, sha) sandbox cache
// ---------------------------------------------------------------------------
//
// Owns the recipe for turning a (WorkflowManifest, bundle source) pair into a
// Sandbox: compiles Ajv input validators per action, builds the per-workflow
// `__hostCallAction` closure, assembles the sandbox source (bundle +
// ACTION_DISPATCHER_SOURCE + action-name binder + trigger shim), and calls
// `sandboxFactory.create`. Sandboxes are held for the lifetime of the store
// — no eviction, no busy/retiring dance. Re-upload on a changed sha orphans
// the old (tenant, oldSha) sandbox, which remains reachable to any in-flight
// invocation until the process exits.

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

function compileActionInputValidator(
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

function throwValidationError(
	message: string,
	issues: ValidationIssue[] | undefined,
): never {
	const err = new Error(message) as Error & { issues?: unknown };
	err.name = "ValidationError";
	err.issues = issues ?? [];
	throw err;
}

interface HostCallDeps {
	readonly workflow: WorkflowManifest;
	readonly logger: Logger;
}

function buildHostCallAction(deps: HostCallDeps) {
	const inputValidators = new Map<
		string,
		(value: unknown) => ValidatorResult<unknown>
	>();
	for (const action of deps.workflow.actions) {
		inputValidators.set(action.name, compileActionInputValidator(action.input));
	}

	return (...args: unknown[]): Promise<undefined> => {
		try {
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
				throwValidationError(
					"action input validation failed",
					inputResult.issues,
				);
			}
			deps.logger.info("action.invoked", {
				workflow: deps.workflow.name,
				action: name,
				input: inputResult.value,
			});
			return Promise.resolve(undefined);
		} catch (err) {
			return Promise.reject(err);
		}
	};
}

// ---------------------------------------------------------------------------
// Sandbox source assembly
// ---------------------------------------------------------------------------
//
// The SDK (as of the bake-action-names-drop-trigger-shim change) bakes
// action names into the bundle at build time and exports trigger callables
// directly — no `__trigger_<name>` shim and no `__setActionName` binder are
// needed anymore. The only source we append is the action-dispatcher IIFE
// that captures `__hostCallAction` + `__emitEvent` into closure locals,
// installs `__dispatchAction` as a locked global, and deletes the two
// bridge names from globalThis. See SECURITY.md §2.
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

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface SandboxStore {
	get(
		tenant: string,
		workflow: WorkflowManifest,
		bundleSource: string,
	): Promise<Sandbox>;
	dispose(): void;
}

interface SandboxStoreOptions {
	readonly sandboxFactory: SandboxFactory;
	readonly logger: Logger;
}

function storeKey(tenant: string, sha: string): string {
	return `${tenant}/${sha}`;
}

function createSandboxStore(options: SandboxStoreOptions): SandboxStore {
	const { sandboxFactory, logger } = options;
	const cache = new Map<string, Promise<Sandbox>>();

	function build(
		_tenant: string,
		workflow: WorkflowManifest,
		bundleSource: string,
	): Promise<Sandbox> {
		const __hostCallAction = buildHostCallAction({ workflow, logger });
		const source = buildSandboxSource(bundleSource);
		return sandboxFactory.create(source, {
			filename: `${workflow.name}.js`,
			methodEventNames: { __hostCallAction: "host.validateAction" },
			methods: { __hostCallAction },
		});
	}

	return {
		get(tenant, workflow, bundleSource) {
			const key = storeKey(tenant, workflow.sha);
			const existing = cache.get(key);
			if (existing) {
				return existing;
			}
			const promise = build(tenant, workflow, bundleSource);
			cache.set(key, promise);
			return promise;
		},
		dispose() {
			for (const promise of cache.values()) {
				promise
					.then((sb) => {
						sb.dispose();
					})
					.catch(() => {
						/* ignore disposal errors */
					});
			}
			cache.clear();
		},
	};
}

export type { SandboxStore, SandboxStoreOptions };
export { createSandboxStore };
