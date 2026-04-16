import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { workflowPlugin } from "@workflow-engine/vite-plugin";
import type { InlineConfig } from "vite";

function discoverWorkflows(root: string): string[] {
	const workflows: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return workflows;
	}
	for (const entry of entries) {
		if (
			entry.endsWith(".ts") &&
			entry !== "vite.config.ts" &&
			!entry.endsWith(".test.ts") &&
			!entry.endsWith(".d.ts")
		) {
			const full = join(root, entry);
			if (statSync(full).isFile()) {
				workflows.push(`./${entry}`);
			}
		}
	}
	return workflows;
}

function defaultViteConfig(root: string): InlineConfig {
	const workflows = discoverWorkflows(root);
	if (workflows.length === 0) {
		throw new Error(`no workflows found in ${root}`);
	}
	return {
		root,
		configFile: false,
		logLevel: "warn",
		plugins: [workflowPlugin({ workflows })],
	};
}

export { defaultViteConfig };
