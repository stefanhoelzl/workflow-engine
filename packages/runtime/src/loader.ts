import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { ManifestSchema, type Manifest, z } from "@workflow-engine/sdk";
import type { Action } from "./actions/index.js";
import type { Logger } from "./logger.js";

interface Schema {
	parse(data: unknown): unknown;
}

interface LoadedWorkflow {
	actions: Action[];
	triggers: Manifest["triggers"];
	events: Record<string, Schema>;
	jsonSchemas: Record<string, object>;
}

async function loadWorkflow(
	dir: string,
	logger: Logger,
): Promise<LoadedWorkflow | undefined> {
	const manifestPath = resolve(dir, "manifest.json");
	let raw: string;
	try {
		raw = await readFile(manifestPath, "utf-8");
	} catch {
		logger.warn("workflow.skip", { dir, reason: "no manifest.json" });
		return;
	}

	let manifest: Manifest;
	try {
		manifest = ManifestSchema.parse(JSON.parse(raw));
	} catch (error) {
		logger.warn("workflow.manifest-invalid", {
			dir,
			error: String(error),
		});
		return;
	}

	const events: Record<string, Schema> = {};
	const jsonSchemas: Record<string, object> = {};
	for (const event of manifest.events) {
		events[event.name] = z.fromJSONSchema(event.schema);
		jsonSchemas[event.name] = event.schema;
	}

	const actions: Action[] = [];
	for (const actionDef of manifest.actions) {
		const sourcePath = resolve(dir, actionDef.module);
		let source: string;
		try {
			// biome-ignore lint/performance/noAwaitInLoops: sequential loading for error reporting
			source = await readFile(sourcePath, "utf-8");
		} catch (error) {
			logger.warn("workflow.action-source-missing", {
				dir,
				module: actionDef.module,
				error: String(error),
			});
			return;
		}
		actions.push({
			name: actionDef.name,
			on: actionDef.on,
			env: actionDef.env,
			source,
		});
	}

	return { actions, triggers: manifest.triggers, events, jsonSchemas };
}

async function loadWorkflows(
	dir: string,
	logger: Logger,
): Promise<LoadedWorkflow[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const subdirs = entries.filter((e) => e.isDirectory());

	const results = await Promise.allSettled(
		subdirs.map(async (entry) => {
			const subdir = resolve(dir, entry.name);
			const result = await loadWorkflow(subdir, logger);
			if (result) {
				logger.info("workflow.loaded", { dir: entry.name });
			}
			return result;
		}),
	);

	const workflows: LoadedWorkflow[] = [];
	for (const [i, result] of results.entries()) {
		if (result.status === "rejected") {
			logger.warn("workflow.load-failed", {
				dir: subdirs[i]?.name,
				error: String(result.reason),
			});
		} else if (result.value !== undefined) {
			workflows.push(result.value);
		}
	}

	return workflows;
}

export { loadWorkflows };
export type { LoadedWorkflow };
