import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { WorkflowConfig } from "@workflow-engine/sdk";
import type { Logger } from "./logger.js";

async function loadWorkflows(
	dir: string,
	logger: Logger,
): Promise<WorkflowConfig[]> {
	const entries = await readdir(dir);
	const jsFiles = entries.filter((f) => f.endsWith(".js"));

	const results = await Promise.allSettled(
		jsFiles.map(async (file) => {
			const filePath = resolve(dir, file);
			const mod: { default?: unknown } = await import(filePath);
			if (!mod.default) {
				logger.warn("workflow.skip", { file, reason: "no default export" });
				return;
			}
			logger.info("workflow.loaded", { file });
			return mod.default as WorkflowConfig;
		}),
	);

	const workflows: WorkflowConfig[] = [];
	for (const [i, result] of results.entries()) {
		if (result.status === "rejected") {
			logger.warn("workflow.load-failed", {
				file: jsFiles[i],
				error: String(result.reason),
			});
		} else if (result.value !== undefined) {
			workflows.push(result.value);
		}
	}

	return workflows;
}

export { loadWorkflows };
