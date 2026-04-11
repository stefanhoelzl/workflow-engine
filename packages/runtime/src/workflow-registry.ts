import { type Manifest, ManifestSchema, z } from "@workflow-engine/sdk";
import type { Action } from "./actions/index.js";
import type { Logger } from "./logger.js";
import type { StorageBackend } from "./storage/index.js";
import { HttpTriggerRegistry } from "./triggers/http.js";

interface Schema {
	parse(data: unknown): unknown;
}

interface LoadedWorkflow {
	actions: Action[];
	triggers: Manifest["triggers"];
	events: Record<string, Schema>;
	jsonSchemas: Record<string, object>;
}

interface WorkflowRegistry {
	register(files: Map<string, string>): Promise<string | undefined>;
	remove(name: string): void;
	recover(): Promise<void>;
	readonly actions: Action[];
	readonly events: Record<string, Schema>;
	readonly jsonSchemas: Record<string, object>;
	readonly triggerRegistry: HttpTriggerRegistry;
}

interface WorkflowRegistryOptions {
	backend?: StorageBackend | undefined;
	logger: Logger;
}

const WORKFLOWS_PREFIX = "workflows/";

type LoadResult =
	| { ok: true; name: string; workflow: LoadedWorkflow }
	| { ok: false; name?: string | undefined; error: string };

function buildLoadedWorkflow(
	manifest: Manifest,
	files: Map<string, string>,
): LoadResult {
	const events: Record<string, Schema> = {};
	const jsonSchemas: Record<string, object> = {};
	for (const event of manifest.events) {
		events[event.name] = z.fromJSONSchema(event.schema);
		jsonSchemas[event.name] = event.schema;
	}

	const actions: Action[] = [];
	for (const actionDef of manifest.actions) {
		const source = files.get(actionDef.module);
		if (source === undefined) {
			return {
				ok: false,
				name: manifest.name,
				error: `missing action source: ${actionDef.module}`,
			};
		}
		actions.push({
			name: actionDef.name,
			on: actionDef.on,
			env: actionDef.env,
			source,
		});
	}

	return {
		ok: true,
		name: manifest.name,
		workflow: { actions, triggers: manifest.triggers, events, jsonSchemas },
	};
}

function loadWorkflow(files: Map<string, string>): LoadResult {
	const manifestRaw = files.get("manifest.json");
	if (!manifestRaw) {
		return { ok: false, error: "missing manifest.json" };
	}

	let manifest: Manifest;
	try {
		manifest = ManifestSchema.parse(JSON.parse(manifestRaw));
	} catch (error) {
		return { ok: false, error: `invalid manifest: ${error}` };
	}

	return buildLoadedWorkflow(manifest, files);
}

function parseWorkflowNames(paths: string[]): string[] {
	const names = new Set<string>();
	for (const path of paths) {
		if (!path.startsWith(WORKFLOWS_PREFIX)) {
			continue;
		}
		const rest = path.slice(WORKFLOWS_PREFIX.length);
		const slashIndex = rest.indexOf("/");
		if (slashIndex > 0) {
			names.add(rest.slice(0, slashIndex));
		}
	}
	return [...names];
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: factory closure groups tightly coupled registry logic
function createWorkflowRegistry(
	options: WorkflowRegistryOptions,
): WorkflowRegistry {
	const { backend, logger } = options;
	const workflows = new Map<string, LoadedWorkflow>();
	let derivedActions: Action[] = [];
	let derivedEvents: Record<string, Schema> = {};
	let derivedJsonSchemas: Record<string, object> = {};
	let derivedTriggerRegistry = new HttpTriggerRegistry();

	function rebuild(): void {
		derivedActions = [];
		derivedEvents = {};
		derivedJsonSchemas = {};
		derivedTriggerRegistry = new HttpTriggerRegistry();

		for (const wf of workflows.values()) {
			derivedActions.push(...wf.actions);
			Object.assign(derivedEvents, wf.events);
			Object.assign(derivedJsonSchemas, wf.jsonSchemas);
			for (const trigger of wf.triggers) {
				derivedTriggerRegistry.register(trigger);
			}
		}
	}

	async function persist(
		name: string,
		files: Map<string, string>,
	): Promise<void> {
		if (!backend) {
			return;
		}
		const prefix = `${WORKFLOWS_PREFIX}${name}/`;
		for (const [filename, content] of files) {
			// biome-ignore lint/performance/noAwaitInLoops: sequential writes for consistency
			await backend.write(`${prefix}${filename}`, content);
		}
	}

	async function readFromBackend(name: string): Promise<Map<string, string>> {
		const files = new Map<string, string>();
		const prefix = `${WORKFLOWS_PREFIX}${name}/`;
		if (!backend) {
			return files;
		}
		for await (const path of backend.list(prefix)) {
			const relative = path.slice(prefix.length);
			const content = await backend.read(path);
			files.set(relative, content);
		}
		return files;
	}

	return {
		async register(files) {
			const result = loadWorkflow(files);
			if (!result.ok) {
				if (result.name && workflows.delete(result.name)) {
					logger.warn("workflow.removed", {
						name: result.name,
						reason: result.error,
					});
					rebuild();
				}
				logger.warn("workflow.register-failed", { error: result.error });
				return;
			}

			await persist(result.name, files);
			workflows.set(result.name, result.workflow);
			rebuild();

			logger.info("workflow.registered", { name: result.name });
			return result.name;
		},

		remove(name) {
			workflows.delete(name);
			rebuild();
		},

		async recover() {
			if (!backend) {
				return;
			}
			const allPaths: string[] = [];
			for await (const path of backend.list(WORKFLOWS_PREFIX)) {
				allPaths.push(path);
			}

			for (const name of parseWorkflowNames(allPaths)) {
				// biome-ignore lint/performance/noAwaitInLoops: sequential loading for error reporting
				const files = await readFromBackend(name);
				const result = loadWorkflow(files);
				if (!result.ok) {
					logger.warn("workflow.load-failed", { name, error: result.error });
					continue;
				}
				workflows.set(result.name, result.workflow);
				logger.info("workflow.loaded", { name: result.name });
			}
			rebuild();
		},

		get actions() {
			return derivedActions;
		},

		get events() {
			return derivedEvents;
		},

		get jsonSchemas() {
			return derivedJsonSchemas;
		},

		get triggerRegistry() {
			return derivedTriggerRegistry;
		},
	};
}

export type { LoadedWorkflow, Schema, WorkflowRegistry };
export { createWorkflowRegistry, parseWorkflowNames };
